package activities

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/controller-agent/temporal-engine/internal/catalog"
)

// RunMCPToolActivityName dispatches one MCPTool call (ADR 0045) by proxying a
// single tools/call through the mcp-broker. The engine never speaks MCP; the
// broker holds the session.
const RunMCPToolActivityName = "RunMCPTool"

// MCPActivities proxies an MCPTool call to the mcp-broker under the CALLER's own
// delegated token.
//
// It is shaped like the knowledge-base GET face (ReadCorpus) on purpose: the
// per-user credential is resolved INSIDE the activity and never returned to the
// workflow, because an activity result is persisted to event history and a
// token handed back would be durable plaintext for its whole retention. The
// orchestrator holds no MCP credential of its own; it forwards one it did not
// mint and cannot widen.
type MCPActivities struct {
	// Credentials resolves the caller's own delegated token for the server's
	// identityProviders (ADR 0032/0040's mechanism).
	Credentials DelegatedCredentialResolver
	// BrokerURL is the mcp-broker's in-cluster base URL.
	BrokerURL string
	// BrokerToken authenticates the engine to the broker (the broker's own gate,
	// distinct from the per-user delegated token it carries onward).
	BrokerToken string
}

// RunMCPToolInput carries the resolved descriptor and the planner's arguments.
type RunMCPToolInput struct {
	Caller Caller `json:"caller"`
	// Tool is the resolved descriptor, carrying the mcpExec spec snapshotted at
	// index time — so this calls exactly the server/remote tool the planner was
	// offered.
	Tool catalog.ToolDescriptor `json:"tool"`
	// Arguments is the planner's tool input: the JSON arguments object for the
	// remote tool, forwarded to the broker verbatim.
	Arguments string `json:"arguments"`
}

// RunMCPToolOutput carries prose or a result, never a credential.
type RunMCPToolOutput struct {
	Result    string `json:"result"`
	Succeeded bool   `json:"succeeded"`
	// NeedsLink is set when the server requires a per-user identity the caller
	// has not linked. The turn asks rather than failing, and — fail closed per
	// ADR 0045 §5 — never falls back to the broker's shared discovery
	// credential.
	NeedsLink bool `json:"needsLink,omitempty"`
}

// RunMCPTool resolves the caller's delegated token (when the server requires
// one), proxies one tools/call through the broker, and maps the result to
// prose. Every "the call did not succeed" outcome is a result for the model to
// reason about (Succeeded=false with a message), never a Go error — a Go error
// is reserved for the broker being unreachable or misbehaving, which should
// retry/surface rather than look like a tool that ran and refused.
func (a *MCPActivities) RunMCPTool(ctx context.Context, in RunMCPToolInput) (RunMCPToolOutput, error) {
	exec := in.Tool.MCPExec
	if exec == nil {
		return RunMCPToolOutput{}, fmt.Errorf("tool %s is not an MCP tool", in.Tool.ID)
	}

	// Resolve the per-user credential only when the server declares it needs
	// one. A server with no identityProviders is called with no delegated token
	// (the broker's discovery identity is never spent on an invocation).
	var delegated string
	if len(in.Tool.IdentityProviders) > 0 {
		credential, err := a.Credentials.DelegatedToken(ctx, in.Caller, in.Tool.IdentityProviders)
		if err != nil {
			return RunMCPToolOutput{}, err
		}
		if credential.Token == "" {
			return RunMCPToolOutput{
				NeedsLink: true,
				Result: fmt.Sprintf(
					"I need you to link the account behind %s before I can call it — "+
						"an MCP tool call has to run as you, not as a shared credential.", exec.ServerRef),
			}, nil
		}
		delegated = credential.Token
	}

	result, isError, err := a.callThroughBroker(ctx, exec.ServerRef, exec.RemoteToolName, in.Arguments, delegated)
	if err != nil {
		return RunMCPToolOutput{}, err
	}
	if isError {
		// The server ran the tool and reported a tool-level error. That is an
		// answer the model can act on (fix the arguments, try another tool), so
		// it comes back as prose rather than a failed activity.
		return RunMCPToolOutput{Result: result}, nil
	}
	return RunMCPToolOutput{Result: result, Succeeded: true}, nil
}

// brokerCallRequest is the body the engine POSTs to the broker. Arguments are
// forwarded as raw JSON so the broker — the only MCP speaker — owns parsing and
// validation against the remote tool's schema.
type brokerCallRequest struct {
	Arguments json.RawMessage `json:"arguments"`
}

// brokerCallResponse is the broker's normalized tools/call result: the MCP
// content flattened to text, plus whether the server flagged it as an error.
type brokerCallResponse struct {
	Result  string `json:"result"`
	IsError bool   `json:"isError"`
	// Message carries a transport/validation failure the broker itself produced
	// (as opposed to a tool-level error the server returned), used for the prose
	// on a non-2xx.
	Message string `json:"message"`
}

func (a *MCPActivities) callThroughBroker(
	ctx context.Context,
	server, remoteTool, arguments, delegated string,
) (result string, isError bool, err error) {
	endpoint := fmt.Sprintf("%s/servers/%s/tools/%s/call",
		strings.TrimRight(a.BrokerURL, "/"), url.PathEscape(server), url.PathEscape(remoteTool))

	args := strings.TrimSpace(arguments)
	if args == "" {
		args = "{}"
	}
	body, err := json.Marshal(brokerCallRequest{Arguments: json.RawMessage(args)})
	if err != nil {
		// The planner handed non-JSON arguments. That is a tool-level problem the
		// model can correct, not a broker fault — prose, not a Go error.
		return fmt.Sprintf("The arguments were not valid JSON for %s/%s: %s", server, remoteTool, err), true, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a.BrokerToken)
	if delegated != "" {
		req.Header.Set("x-delegated-token", delegated)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false, fmt.Errorf("mcp-broker unreachable: %w", err)
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", false, err
	}

	var parsed brokerCallResponse
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return "", false, fmt.Errorf("decode mcp-broker response: %w", err)
		}
	}

	if res.StatusCode != http.StatusOK {
		// A refusal from the broker (unknown tool, expired/forbidden delegated
		// token, server unreachable) is returned as prose the model can act on,
		// mirroring the knowledge-base GET face: a failed activity just ends the
		// turn where a message lets the model recover or explain.
		msg := strings.TrimSpace(parsed.Message)
		if msg == "" {
			msg = strings.TrimSpace(string(raw))
		}
		return fmt.Sprintf("The MCP server refused that call (%d). %s", res.StatusCode, msg), true, nil
	}

	return parsed.Result, parsed.IsError, nil
}
