import OpenAI from "openai";

/**
 * Answers Open WebUI's internal housekeeping completions (chat title, tags,
 * search query, follow-up question generation — see
 * `isInternalUiTaskRequest` in ./chat-completions.ts) with a direct,
 * non-agentic OpenAI call. These bypass the agent graph entirely so a
 * background UI call can never be misrouted into skill/agent delegation —
 * critically, into a `tier: privileged` agent that would clone/create real
 * repos or open real pull requests for what should be a cheap, side-effect-
 * free text completion.
 */
export interface TaskCompleter {
  complete(messages: unknown, model: string): Promise<string>;
}

export interface OpenAiTaskCompleterOptions {
  client?: OpenAI;
}

export class OpenAiTaskCompleter implements TaskCompleter {
  private readonly client: OpenAI;

  constructor(opts: OpenAiTaskCompleterOptions = {}) {
    this.client = opts.client ?? new OpenAI();
  }

  async complete(messages: unknown, model: string): Promise<string> {
    const response = await this.client.chat.completions.create({
      model,
      temperature: 0,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    });
    return response.choices[0]?.message?.content ?? "";
  }
}
