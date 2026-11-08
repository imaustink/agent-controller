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

package eventcel

import (
	"testing"

	"github.com/google/cel-go/cel"
)

func TestCompile(t *testing.T) {
	cases := []struct {
		name    string
		expr    string
		want    *cel.Type
		wantErr bool
	}{
		{"envelope match", `headers["x-github-event"] == "pull_request" && body.action == "labeled"`, cel.BoolType, false},
		{"every variable", `source == "a" && kind == "cron" && id != "" && time != "" && repository == "" && sender.isBot == false`, cel.BoolType, false},
		{"dyn body is accepted for a typed result", `body.repository.full_name`, cel.StringType, false},
		{"macros and string ops", `body.labels.exists(l, l.name.startsWith("ai-"))`, cel.BoolType, false},
		{"untyped param", `body.pull_request.number`, nil, false},
		{"syntax error", `body.action ==`, nil, true},
		{"undeclared variable", `request.body == "x"`, nil, true},
		{"headers are strings", `headers["a"] == 1`, nil, true},
		{"wrong static result type", `"labeled"`, cel.BoolType, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := Compile(tc.expr, tc.want)
			if tc.wantErr && err == nil {
				t.Fatalf("Compile(%q) succeeded, want an error", tc.expr)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("Compile(%q): %v", tc.expr, err)
			}
		})
	}
}
