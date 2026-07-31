"""
Tests for tool/helm_values_form.py.

Open WebUI always has fastapi and pydantic; a fresh checkout does not
necessarily. These tests use the real packages when they are importable and fall
back to minimal stand-ins otherwise, reporting which. The stand-ins are faithful
about the only things asserted here -- that HTMLResponse is constructed with the
body and headers we think it is -- so a wrong header name or a one-element return
still fails without fastapi installed.

Run with: python3 -m unittest discover -s tests -p 'test_*.py' -t .
"""

import importlib.util
import json
import os
import re
import sys
import types
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _install_stubs():
    """Minimal stand-ins for fastapi.responses.HTMLResponse and pydantic."""
    using_real = []

    try:
        import fastapi.responses  # noqa: F401

        using_real.append("fastapi")
    except ImportError:

        class HTMLResponse:
            media_type = "text/html"

            def __init__(self, content="", status_code=200, headers=None, **kwargs):
                self.body = content.encode("utf-8") if isinstance(content, str) else content
                self.status_code = status_code
                self.headers = dict(headers or {})

        fastapi = types.ModuleType("fastapi")
        responses = types.ModuleType("fastapi.responses")
        responses.HTMLResponse = HTMLResponse
        fastapi.responses = responses
        sys.modules["fastapi"] = fastapi
        sys.modules["fastapi.responses"] = responses

    try:
        import pydantic  # noqa: F401

        using_real.append("pydantic")
    except ImportError:

        class FieldInfo:
            def __init__(self, default=None, description=None):
                self.default = default
                self.description = description

        def Field(default=None, description=None, **kwargs):
            return FieldInfo(default=default, description=description)

        class BaseModel:
            def __init__(self, **overrides):
                for name in dir(type(self)):
                    if name.startswith("_"):
                        continue
                    value = getattr(type(self), name)
                    if isinstance(value, FieldInfo):
                        setattr(self, name, value.default)
                for key, value in overrides.items():
                    setattr(self, key, value)

        pydantic = types.ModuleType("pydantic")
        pydantic.BaseModel = BaseModel
        pydantic.Field = Field
        sys.modules["pydantic"] = pydantic

    return using_real


REAL = _install_stubs()


def _load_tool():
    path = os.path.join(REPO, "tool", "helm_values_form.py")
    spec = importlib.util.spec_from_file_location("helm_values_form", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_tool()


def _configured():
    """A Tools instance pointed at this checkout's real bundle and chart sidecars."""
    tools = mod.Tools()
    tools.valves.bundle_path = os.path.join(REPO, "dist", "owui-form.js")
    tools.valves.charts_dir = os.path.join(REPO, "charts")
    return tools


def _run(coro):
    import asyncio

    return asyncio.new_event_loop().run_until_complete(coro)


class TestShowValuesForm(unittest.TestCase):
    def setUp(self):
        self.tools = _configured()
        if not os.path.isfile(self.tools.valves.bundle_path):
            self.skipTest("dist/owui-form.js is missing; run `npm run build` first")

    def test_returns_a_two_tuple_of_html_response_and_context(self):
        result = self.tools.show_values_form("temporal-worker")

        self.assertIsInstance(result, tuple)
        self.assertEqual(len(result), 2)

        response, context = result
        self.assertEqual(type(response).__name__, "HTMLResponse")
        self.assertIsInstance(context, dict)

    def test_response_carries_the_inline_content_disposition_header(self):
        # This header is the entire mechanism: without it Open WebUI never pulls
        # the HTML out to render it as an embed.
        response, _ = self.tools.show_values_form("temporal-worker")
        headers = {k.lower(): v for k, v in dict(response.headers).items()}
        self.assertEqual(headers.get("content-disposition"), "inline")

    def test_context_tells_the_model_not_to_interview_the_user(self):
        _, context = self.tools.show_values_form("temporal-worker")
        self.assertEqual(context["chart"], "temporal-worker")
        self.assertIn("image.tag", context["included_paths"])
        self.assertIn("do not ask", context["instructions"].lower())
        self.assertIn("record_values", context["instructions"])

    def test_html_has_both_markers_substituted(self):
        response, _ = self.tools.show_values_form("temporal-worker")
        html = response.body.decode("utf-8")

        self.assertNotIn(mod.BUNDLE_MARKER, html)
        self.assertNotIn(mod.CONFIG_MARKER, html)
        self.assertIn("var OWUIForm=", html)
        self.assertIn("OWUIForm.render(root, CFG", html)
        # The height reporter has to survive substitution too.
        self.assertIn("iframe:height", html)

    def test_config_is_escaped_so_a_description_cannot_end_the_script(self):
        # Chart descriptions contain HTML more often than you would expect.
        hostile = '</script><img src=x onerror="alert(1)">'
        schema = {
            "type": "object",
            "properties": {"a": {"type": "string", "description": hostile}},
        }
        html = self.tools._build_html({"chart": "x", "title": "x", "schema": schema})

        # One closing script tag per opening one, and none of them from the config.
        self.assertEqual(html.count("</script>"), html.count("<script>"))
        self.assertNotIn(hostile, html)
        self.assertIn("\\u003c/script", html)

    def test_only_the_allowlisted_paths_reach_the_form(self):
        response, _ = self.tools.show_values_form("temporal-worker")
        html = response.body.decode("utf-8")
        config = json.loads(
            re.search(r"var CFG = (\{.*?\});", html, re.S).group(1).replace("\\u003c", "<")
        )
        props = config["schema"]["properties"]

        self.assertEqual(
            sorted(props),
            ["image", "podAnnotations", "replicaCount", "resources", "temporal"],
        )
        # Intermediate nodes survive, narrowed to the leaves that were asked for.
        self.assertEqual(sorted(props["image"]["properties"]), ["tag"])
        self.assertEqual(sorted(props["temporal"]["properties"]), ["namespace", "taskQueue"])
        self.assertEqual(sorted(props["resources"]["properties"]), ["limits"])
        self.assertEqual(
            sorted(props["resources"]["properties"]["limits"]["properties"]),
            ["cpu", "memory"],
        )
        # `required` is narrowed to fields that actually render.
        self.assertEqual(props["image"].get("required"), ["tag"])
        self.assertEqual(sorted(props["temporal"].get("required", [])), ["namespace", "taskQueue"])
        # Pruned-away branches are gone entirely.
        self.assertNotIn("requests", props["resources"]["properties"])
        self.assertNotIn("nodeSelector", props)

    def test_unknown_chart_returns_a_string_listing_what_exists(self):
        result = self.tools.show_values_form("no-such-chart")
        self.assertIsInstance(result, str)
        self.assertIn("no-such-chart", result)
        self.assertIn("temporal-worker", result)

    def test_a_chart_name_cannot_escape_the_charts_directory(self):
        result = self.tools.show_values_form("../../etc/passwd")
        self.assertIsInstance(result, str)
        self.assertIn("no values form", result.lower())

    def test_bundle_over_budget_is_refused_with_a_clear_message(self):
        self.tools.valves.max_bundle_bytes = 10
        result = self.tools.show_values_form("temporal-worker")
        self.assertIsInstance(result, str)
        self.assertIn("max_bundle_bytes", result)

    def test_config_over_budget_is_refused_with_a_clear_message(self):
        self.tools.valves.max_config_bytes = 10
        result = self.tools.show_values_form("temporal-worker")
        self.assertIsInstance(result, str)
        self.assertIn("max_config_bytes", result)
        self.assertIn("allowlist", result)


class TestStaleAllowlist(unittest.TestCase):
    def test_an_unresolvable_include_path_is_reported(self):
        schema = {
            "type": "object",
            "properties": {"image": {"type": "object", "properties": {"tag": {"type": "string"}}}},
        }
        _, missing = mod._prune_schema(schema, ["image.tag", "image.digest"])
        self.assertEqual(missing, ["image.digest"])

    def test_show_values_form_refuses_rather_than_silently_dropping(self):
        tools = _configured()
        original = tools._load_form

        def patched(chart):
            form = original(chart)
            form["include"] = list(form.get("include", [])) + ["image.digest"]
            return form

        tools._load_form = patched
        result = tools.show_values_form("temporal-worker")
        self.assertIsInstance(result, str)
        self.assertIn("image.digest", result)
        self.assertIn("allowlist", result)


class TestSchemaPruning(unittest.TestCase):
    def test_an_empty_include_keeps_the_whole_schema(self):
        schema = {
            "type": "object",
            "properties": {"a": {"type": "string"}, "b": {"type": "string"}},
        }
        pruned, missing = mod._prune_schema(schema, [])
        self.assertEqual(missing, [])
        self.assertEqual(pruned, schema)

    def test_refs_reachable_from_the_pruned_tree_are_carried_along(self):
        schema = {
            "type": "object",
            "properties": {
                "kept": {"$ref": "#/$defs/a"},
                "dropped": {"$ref": "#/$defs/unused"},
            },
            "$defs": {
                "a": {"type": "object", "properties": {"inner": {"$ref": "#/$defs/b"}}},
                "b": {"type": "string"},
                "unused": {"type": "string"},
            },
        }
        pruned, missing = mod._prune_schema(schema, ["kept"])
        self.assertEqual(missing, [])
        # Transitively reachable defs come along; the unreferenced one does not,
        # since it would count against max_config_bytes for nothing.
        self.assertEqual(sorted(pruned["$defs"]), ["a", "b"])

    def test_a_path_through_a_ref_resolves(self):
        schema = {
            "type": "object",
            "properties": {"temporal": {"$ref": "#/$defs/t"}},
            "$defs": {"t": {"type": "object", "properties": {"tls": {"type": "boolean"}}}},
        }
        pruned, missing = mod._prune_schema(schema, ["temporal.tls"])
        self.assertEqual(missing, [])
        self.assertEqual(sorted(pruned["properties"]["temporal"]["properties"]), ["tls"])

    def test_a_path_into_a_free_form_map_key_space_does_not_resolve(self):
        schema = {
            "type": "object",
            "properties": {
                "podAnnotations": {"type": "object", "additionalProperties": {"type": "string"}}
            },
        }
        _, missing = mod._prune_schema(schema, ["podAnnotations.foo"])
        self.assertEqual(missing, ["podAnnotations.foo"])

    def test_properties_keep_the_schemas_declaration_order(self):
        # Not the order the paths appear in `include`. The emitted YAML follows
        # this order, so keying it off the allowlist would reshuffle a committed
        # values file whenever someone reordered the allowlist.
        schema = {
            "type": "object",
            "properties": {
                "alpha": {"type": "string"},
                "beta": {"type": "object", "properties": {"x": {"type": "string"}, "y": {"type": "string"}}},
                "gamma": {"type": "string"},
            },
        }
        pruned, _ = mod._prune_schema(schema, ["gamma", "beta.y", "alpha", "beta.x"])
        self.assertEqual(list(pruned["properties"]), ["alpha", "beta", "gamma"])
        self.assertEqual(list(pruned["properties"]["beta"]["properties"]), ["x", "y"])

    def test_the_real_chart_keeps_its_declaration_order(self):
        with open(os.path.join(REPO, "charts", "temporal-worker.schema.json")) as fh:
            schema = json.load(fh)
        with open(os.path.join(REPO, "charts", "temporal-worker.form.json")) as fh:
            include = json.load(fh)["include"]
        pruned, _ = mod._prune_schema(schema, include)
        # replicaCount is declared first even though image.tag is allowlisted first.
        self.assertEqual(
            list(pruned["properties"]),
            [k for k in schema["properties"] if k in pruned["properties"]],
        )
        self.assertEqual(list(pruned["properties"])[0], "replicaCount")

    def test_pruning_is_deterministic(self):
        with open(os.path.join(REPO, "charts", "temporal-worker.schema.json")) as fh:
            schema = json.load(fh)
        include = ["image.tag", "temporal.tls.secretName", "resources.limits.cpu"]
        first, _ = mod._prune_schema(schema, include)
        second, _ = mod._prune_schema(schema, include)
        self.assertEqual(json.dumps(first), json.dumps(second))

    def test_the_real_chart_prunes_well_under_the_config_budget(self):
        with open(os.path.join(REPO, "charts", "temporal-worker.schema.json")) as fh:
            schema = json.load(fh)
        with open(os.path.join(REPO, "charts", "temporal-worker.form.json")) as fh:
            form = json.load(fh)
        pruned, missing = mod._prune_schema(schema, form["include"])
        self.assertEqual(missing, [])
        size = len(json.dumps(pruned, separators=(",", ":")).encode("utf-8"))
        self.assertLess(size, mod.Tools().valves.max_config_bytes)
        # And meaningfully smaller than the schema it came from, or the allowlist
        # is not doing its job.
        full = len(json.dumps(schema, separators=(",", ":")).encode("utf-8"))
        self.assertLess(size, full * 0.7)


class TestAppInterfaceChart(unittest.TestCase):
    """The second sidecar: a platform interface schema rather than a Helm chart's."""

    def setUp(self):
        self.tools = _configured()
        if not os.path.isfile(self.tools.valves.bundle_path):
            self.skipTest("dist/owui-form.js is missing; run `npm run build` first")

    def test_it_is_offered_alongside_the_chart(self):
        out = self.tools.list_charts()
        self.assertIn("app-interface", out)
        self.assertIn("temporal-worker", out)

    def test_an_empty_include_renders_the_whole_schema(self):
        response, context = self.tools.show_values_form("app-interface")
        self.assertEqual(type(response).__name__, "HTMLResponse")
        # The README discourages an empty allowlist, but a purpose-built
        # interface schema is already form-sized -- which is what makes it the
        # documented exception rather than an oversight.
        self.assertEqual(context["included_paths"], ["(entire schema)"])

        html = response.body.decode("utf-8")
        config = json.loads(
            re.search(r"var CFG = (\{.*?\});", html, re.S).group(1).replace("\\u003c", "<")
        )
        self.assertEqual(
            sorted(config["schema"]["properties"]),
            [
                "capabilities",
                "dependencies",
                "deployBranch",
                "env",
                "infra",
                "name",
                "repo",
                "secrets",
                "workloads",
            ],
        )
        # The conditional rules have to survive into the form, or the renderer
        # cannot know which fields a variant forbids.
        workload = config["schema"]["definitions"]["workload"]
        self.assertEqual(len(workload["allOf"]), 5)
        self.assertIn("propertyNames", config["schema"]["properties"]["workloads"])

    def test_the_whole_schema_fits_the_config_budget(self):
        with open(os.path.join(REPO, "charts", "app-interface.schema.json")) as fh:
            schema = json.load(fh)
        size = len(json.dumps(schema, separators=(",", ":")).encode("utf-8"))
        self.assertLess(size, mod.Tools().valves.max_config_bytes)

    def test_a_path_into_a_definition_backed_property_resolves(self):
        with open(os.path.join(REPO, "charts", "app-interface.schema.json")) as fh:
            schema = json.load(fh)
        pruned, missing = mod._prune_schema(schema, ["name", "infra.hostedZone"])
        self.assertEqual(missing, [])
        self.assertEqual(sorted(pruned["properties"]), ["infra", "name"])
        self.assertEqual(sorted(pruned["properties"]["infra"]["properties"]), ["hostedZone"])

    def test_a_path_into_a_keyed_map_is_a_hard_error(self):
        # `workloads` is a map whose keys belong to the user, so `workloads.web`
        # is not a schema property and cannot be allowlisted.
        with open(os.path.join(REPO, "charts", "app-interface.schema.json")) as fh:
            schema = json.load(fh)
        _, missing = mod._prune_schema(schema, ["workloads.web.port"])
        self.assertEqual(missing, ["workloads.web.port"])


class TestListCharts(unittest.TestCase):
    def test_lists_the_configured_charts(self):
        out = _configured().list_charts()
        self.assertIn("temporal-worker", out)
        self.assertIn("Temporal Worker", out)

    def test_says_so_when_none_are_configured(self):
        tools = _configured()
        tools.valves.charts_dir = os.path.join(REPO, "does-not-exist")
        self.assertIn("No charts are configured", tools.list_charts())


class TestRecordValues(unittest.TestCase):
    def test_emits_a_persisted_replacing_embeds_event(self):
        events = []

        async def emitter(event):
            events.append(event)

        summary = _run(
            _configured().record_values(
                chart="temporal-worker",
                paths="image.tag, resources.limits.memory",
                __event_emitter__=emitter,
            )
        )

        self.assertEqual(len(events), 1)
        event = events[0]
        # The short name: the chat:message:embeds alias renders identically but is
        # not persisted, so a reloaded chat would show the live form again.
        self.assertEqual(event["type"], "embeds")
        self.assertTrue(event["data"]["replace"])
        self.assertEqual(len(event["data"]["embeds"]), 1)

        receipt = event["data"]["embeds"][0]
        self.assertIn("temporal-worker", receipt)
        self.assertIn("image.tag", receipt)
        self.assertIn("resources.limits.memory", receipt)
        # A receipt is inert, but it still has to report its height.
        self.assertIn("iframe:height", receipt)
        self.assertNotIn("<input", receipt)
        self.assertNotIn("OWUIForm", receipt)

        self.assertIn("image.tag", summary)

    def test_escapes_what_it_is_handed(self):
        events = []

        async def emitter(event):
            events.append(event)

        _run(
            _configured().record_values(
                chart='<img src=x onerror="alert(1)">',
                paths="<script>bad()</script>",
                __event_emitter__=emitter,
            )
        )
        receipt = events[0]["data"]["embeds"][0]
        self.assertNotIn("<img", receipt)
        self.assertNotIn("<script>bad", receipt)
        self.assertIn("&lt;img", receipt)

    def test_says_so_when_nothing_was_overridden(self):
        events = []

        async def emitter(event):
            events.append(event)

        summary = _run(
            _configured().record_values(
                chart="temporal-worker", paths="", __event_emitter__=emitter
            )
        )
        self.assertIn("overrode nothing", summary)
        self.assertIn("Nothing was overridden", events[0]["data"]["embeds"][0])

    def test_does_not_claim_success_without_an_emitter(self):
        summary = _run(_configured().record_values(chart="temporal-worker", paths="image.tag"))
        self.assertIn("could not be replaced", summary)


class TestToolSurface(unittest.TestCase):
    """Open WebUI builds the model-facing spec from type hints plus :param lines."""

    def test_every_public_method_documents_every_non_reserved_parameter(self):
        import inspect

        for name in ("show_values_form", "record_values", "list_charts"):
            method = getattr(mod.Tools, name)
            doc = inspect.getdoc(method) or ""
            for param in inspect.signature(method).parameters.values():
                if param.name == "self" or param.name.startswith("__"):
                    continue
                with self.subTest(method=name, param=param.name):
                    self.assertIn(":param %s:" % param.name, doc)
                    self.assertIsNot(param.annotation, inspect.Parameter.empty)
            # Reserved args are stripped by Open WebUI and must NOT be documented.
            self.assertNotIn(":param __", doc)

    def test_the_frontmatter_docstring_is_present(self):
        with open(os.path.join(REPO, "tool", "helm_values_form.py")) as fh:
            head = fh.read(1200)
        for key in ("title:", "author:", "version:", "required_open_webui_version:"):
            self.assertIn(key, head)


class TestEmbeddedShell(unittest.TestCase):
    def test_matches_the_html_file_on_disk(self):
        with open(os.path.join(REPO, "shell", "form_shell.html")) as fh:
            on_disk = fh.read()
        self.assertEqual(
            mod.SHELL_HTML,
            on_disk,
            "tool/helm_values_form.py is out of sync with shell/form_shell.html; "
            "run `npm run sync-shell`.",
        )

    def test_the_shell_uses_no_form_element_and_no_submit_button(self):
        # Form submission inside an Open WebUI embed is gated behind a per-user
        # setting that defaults to off.
        self.assertNotIn("<form", mod.SHELL_HTML)
        self.assertNotIn('type="submit"', mod.SHELL_HTML)

    def test_the_shell_does_not_depend_on_window_args(self):
        # window.args is only injected with same-origin access enabled, which is
        # off by default; everything must arrive through the config marker.
        self.assertNotIn("window.args", mod.SHELL_HTML)


if __name__ == "__main__":
    if REAL:
        print("using real %s" % ", ".join(REAL), file=sys.stderr)
    unittest.main()
