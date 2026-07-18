import unittest
from unittest.mock import patch

import console_shim


class GenerationCreditBreakdownTests(unittest.TestCase):
    def test_refunded_failure_has_zero_net_cost(self):
        self.assertEqual(
            console_shim.generation_credit_breakdown({"cost": 8, "refunded": True}),
            {"credit_cost": 8, "net_credit_cost": 0, "refund_cost": 8},
        )

    def test_success_keeps_full_net_cost(self):
        self.assertEqual(
            console_shim.generation_credit_breakdown({"cost": 5, "refunded": False}),
            {"credit_cost": 5, "net_credit_cost": 5, "refund_cost": 0},
        )

    def test_old_backend_without_refund_field_remains_compatible(self):
        self.assertEqual(
            console_shim.generation_credit_breakdown({"cost": 5}),
            {"credit_cost": 5, "net_credit_cost": 5, "refund_cost": 0},
        )

    def test_user_log_query_is_filtered_before_pagination(self):
        seen = []

        def fake_i2a(method, path, body=None, timeout=15, _retry=True):
            seen.append((method, path))
            return 200, {"data": [], "total": 0}

        with patch.object(console_shim, "i2a", fake_i2a):
            console_shim.ep_logs_get({"user": ["u-OVCADXOLFY"], "limit": ["5000"]})

        self.assertEqual(
            seen,
            [("GET", "/admin/api/logs?limit=5000&scope=all&user=u-OVCADXOLFY")],
        )


if __name__ == "__main__":
    unittest.main()
