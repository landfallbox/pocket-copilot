import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import comfy_media as comfy


class WorkflowTests(unittest.TestCase):
    def test_text_image_dimensions_and_batch(self):
        request = comfy.prepare_request(
            {"mode": "t2i", "prompt": "test", "width": 1344,
             "height": 768, "batch_size": 2, "seed": 42}, Path.cwd())
        workflow = comfy.patch_workflow(request, [])
        self.assertEqual(workflow["459:456"]["inputs"],
                         {"width": 1344, "height": 768, "batch_size": 2})
        self.assertEqual(workflow["459:458"]["inputs"]["seed"], 42)
        self.assertEqual(workflow["459:452"]["inputs"]["prompt"], "test")

    def test_one_and_two_images_have_no_dangling_links(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "input.png"
            image.touch()
            for count in (1, 2):
                request = comfy.prepare_request(
                    {"mode": "i2i", "prompt": "edit <image1>",
                     "input_images": [str(image)] * count}, Path(directory))
                workflow = comfy.patch_workflow(request, [f"upload{i}.png" for i in range(count)])
                self.assertEqual("475" in workflow, count == 2)
                self.assertEqual("images.image_2" in workflow["459:474"]["inputs"], count == 2)
                self.assertEqual(workflow["470"]["inputs"]["image"], "upload0.png")
                for node in workflow.values():
                    for value in node["inputs"].values():
                        if isinstance(value, list):
                            self.assertIn(value[0], workflow)
            with self.assertRaises(comfy.SkillError):
                comfy.prepare_request({"mode": "i2i", "prompt": "test",
                                       "input_images": [str(image)] * 3}, Path(directory))

    def test_bearer_ignores_legacy_session(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {}, clear=True):
            env = Path(directory) / ".env"
            env.write_text("Comfy_BASE_URL=http://localhost:8188\nComfy_API_KEY=test-token\n"
                           "Comfy_AUTH_MODE=cookie\nComfy_AIOHTTP_SESSION=obsolete\n")
            settings = comfy.Settings.load(env)
            self.assertEqual(settings.auth_headers(), {"Authorization": "Bearer test-token"})
            client = comfy.ComfyClient(settings)
            self.assertNotIn("Cookie", client.default_headers)
            for token in ("", "not a token"):
                env.write_text(f"Comfy_BASE_URL=http://localhost:8188\nComfy_API_KEY={token}\n")
                with self.assertRaises(comfy.SkillError):
                    comfy.Settings.load(env)

    def test_registry_is_valid(self):
        self.assertTrue(comfy.validate_workflows()["ok"])
        self.assertEqual(len(comfy.load_model_profiles()), 5)


if __name__ == "__main__":
    unittest.main()
