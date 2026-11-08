/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Package eventcel is the CEL environment event expressions are written
// against (docs/event-triggers.md §3). core-controller only compiles: a
// trigger or source whose expressions do not compile is reported NotReady so
// the engines never get the chance to evaluate it.
package eventcel

import (
	"fmt"
	"sync"

	"github.com/google/cel-go/cel"
)

// env declares exactly the envelope's variables, and nothing else: an
// expression referencing anything outside the envelope is a compile error
// here, as it is in both engines.
var env = sync.OnceValues(func() (*cel.Env, error) {
	return cel.NewEnv(
		cel.Variable("source", cel.StringType),
		cel.Variable("kind", cel.StringType),
		cel.Variable("id", cel.StringType),
		cel.Variable("time", cel.StringType),
		cel.Variable("repository", cel.StringType),
		cel.Variable("headers", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("body", cel.DynType),
		cel.Variable("sender", cel.MapType(cel.StringType, cel.DynType)),
	)
})

// Compile parses and type-checks expr against the envelope. want, when
// non-nil, is the result type the caller needs; an expression whose checked
// type is dyn is accepted, because anything read from body is dyn until it is
// evaluated.
func Compile(expr string, want *cel.Type) error {
	e, err := env()
	if err != nil {
		return fmt.Errorf("building CEL environment: %w", err)
	}
	ast, iss := e.Compile(expr)
	if iss.Err() != nil {
		return iss.Err()
	}
	if want == nil {
		return nil
	}
	got := ast.OutputType()
	if got.IsExactType(cel.DynType) || got.IsExactType(want) {
		return nil
	}
	return fmt.Errorf("expression yields %s, want %s", got, want)
}
