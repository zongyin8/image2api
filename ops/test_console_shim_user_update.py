import unittest
from unittest.mock import patch

import console_shim


class ConsoleShimUserUpdateTests(unittest.TestCase):
    def test_update_applies_profile_password_before_credits(self):
        calls = []

        def fake_i2a(method, path, body=None, timeout=15, _retry=True):
            calls.append((method, path, body))
            return 200, {"ok": True}

        with patch.object(console_shim, "i2a", side_effect=fake_i2a):
            status, body = console_shim.ep_user_post("user/1", {
                "name": "new name",
                "enabled": False,
                "password": "ValidPass1!",
                "quota": 88,
            })

        self.assertEqual((status, body), (200, {"ok": True}))
        self.assertEqual(calls, [
            ("PATCH", "/admin/api/users/user/1", {
                "name": "new name",
                "status": "disabled",
                "password": "ValidPass1!",
            }),
            ("POST", "/admin/api/users/user/1/credits", {"set": 88}),
        ])

    def test_update_stops_when_password_patch_fails(self):
        calls = []

        def fake_i2a(method, path, body=None, timeout=15, _retry=True):
            calls.append((method, path, body))
            return 400, {"detail": "密码格式不符合要求"}

        with patch.object(console_shim, "i2a", side_effect=fake_i2a):
            status, body = console_shim.ep_user_post("u1", {
                "password": "weak",
                "quota": 10,
            })

        self.assertEqual(status, 400)
        self.assertEqual(body["detail"], "密码格式不符合要求")
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
