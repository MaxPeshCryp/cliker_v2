"""PWA resources are installable, correctly typed, and explicitly public."""

from io import BytesIO
import unittest

from PIL import Image

import app as clicker


class PwaTests(unittest.TestCase):
    def setUp(self):
        self.client = clicker.app.test_client()

    def test_manifest_and_all_installation_icons(self):
        with self.client.get("/manifest.webmanifest") as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, "application/manifest+json")
            self.assertIn("no-cache", response.headers["Cache-Control"])
            manifest = response.get_json()
        self.assertEqual(manifest["start_url"], "/")
        self.assertEqual(manifest["scope"], "/")
        self.assertEqual(manifest["display"], "fullscreen")
        self.assertTrue(any(icon["purpose"] == "maskable" for icon in manifest["icons"]))
        for icon in manifest["icons"] + [{"src": "/assets/icons/apple-touch-icon.png", "sizes": "180x180"}]:
            with self.subTest(icon=icon["src"]), self.client.get(icon["src"]) as response:
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.mimetype, "image/png")
                image = Image.open(BytesIO(response.data))
                self.assertEqual("x".join(map(str, image.size)), icon["sizes"])
                image.verify()

    def test_worker_and_offline_document_are_available_without_login(self):
        for path, content_type in (("/pwa.js", "javascript"), ("/service-worker.js", "javascript"), ("/offline.html", "text/html")):
            with self.subTest(path=path), self.client.get(path) as response:
                self.assertEqual(response.status_code, 200)
                self.assertIn(content_type, response.mimetype)
                self.assertIn("no-cache", response.headers["Cache-Control"])
                if path == "/service-worker.js":
                    self.assertEqual(response.headers["Service-Worker-Allowed"], "/")

    def test_pwa_routes_do_not_expose_other_project_files(self):
        for path in ("/.env", "/app.py", "/clicker.db", "/assets/icons/README.md", "/assets/icons/../../.env"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)


if __name__ == "__main__":
    unittest.main()
