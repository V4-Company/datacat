import time
import unittest

try:
    import flask
except ImportError:  # pragma: no cover
    flask = None

from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter


@unittest.skipIf(flask is None, "flask not installed")
class FlaskStreamTests(unittest.TestCase):
    def test_span_covers_streamed_body(self):
        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        from datacat._fast_flask import patch_flask
        self.assertTrue(patch_flask())
        app = flask.Flask("t")

        @app.route("/stream")
        def stream():
            def gen():
                for _ in range(3):
                    time.sleep(0.05)
                    yield b"x"
            return flask.Response(gen())

        resp = app.test_client().get("/stream")
        body = resp.data
        resp.close()  # a WSGI server closes the body after sending it
        self.assertEqual(body, b"xxx")
        spans = [s for s in exporter.get_finished_spans() if s.name.endswith("/stream")]
        self.assertEqual(len(spans), 1)
        self.assertGreaterEqual((spans[0].end_time - spans[0].start_time) / 1e9, 0.14)
        self.assertEqual(spans[0].attributes.get("http.response.status_code"), 200)


if __name__ == "__main__":
    unittest.main()
