from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from . import openai_register
from .mail_provider import TempMailLolProvider


class ProfileMailboxNameTests(unittest.TestCase):
    @patch.object(openai_register.secrets, "randbelow", return_value=1)
    @patch.object(openai_register.secrets, "choice", side_effect=list("4827"))
    def test_name_matches_profile_and_uses_three_to_five_random_digits(self, choice: Mock, randbelow: Mock) -> None:
        self.assertEqual(openai_register._profile_mailbox_name("Olivia", "Smith"), "oliviasmith4827")

    @patch.object(openai_register.secrets, "randbelow", return_value=2)
    @patch.object(openai_register.secrets, "choice", side_effect=list("12345"))
    def test_name_is_provider_safe_and_bounded(self, choice: Mock, randbelow: Mock) -> None:
        value = openai_register._profile_mailbox_name("Mary-Jane", "O'Williams", max_length=18)
        self.assertEqual(value, "maryjaneowill12345")
        self.assertEqual(len(value), 18)
        self.assertTrue(value.isalnum())

    @patch.object(openai_register, "wait_for_code", return_value="123456")
    @patch.object(openai_register, "_random_birthdate", return_value="2000-01-02")
    @patch.object(openai_register, "_random_password", return_value="Password1!")
    @patch.object(openai_register, "_random_name", return_value=("Olivia", "Smith"))
    @patch.object(openai_register, "_profile_mailbox_name", return_value="oliviasmith4827")
    @patch.object(openai_register, "create_mailbox")
    def test_register_uses_the_same_name_for_mailbox_and_profile(
        self,
        create_mailbox: Mock,
        _profile_mailbox_name: Mock,
        _random_name: Mock,
        _random_password: Mock,
        _random_birthdate: Mock,
        wait_for_code: Mock,
    ) -> None:
        create_mailbox.return_value = {"address": "oliviasmith4827@example.com"}
        registrar = openai_register.PlatformRegistrar.__new__(openai_register.PlatformRegistrar)
        registrar.proxy = ""
        registrar.mailbox = None
        registrar.otp_sent = False
        registrar._platform_authorize = Mock()
        registrar._authorize_continue = Mock()
        registrar._register_user = Mock()
        registrar._send_otp = Mock()
        registrar._validate_otp = Mock()
        registrar._create_account = Mock(return_value="https://example.com/continue")
        registrar._login_and_exchange_tokens = Mock(
            return_value={"access_token": "access", "refresh_token": "refresh", "id_token": "id"}
        )

        registrar.register(23)

        create_mailbox.assert_called_once_with(username="oliviasmith4827", proxy="")
        registrar._create_account.assert_called_once_with("Olivia Smith", "2000-01-02", 23)


class TempMailLolMailboxNameTests(unittest.TestCase):
    def test_custom_name_wins_for_wildcard_domains(self) -> None:
        provider = TempMailLolProvider.__new__(TempMailLolProvider)
        provider.domain = ["*.example.com"]
        provider.provider_ref = "test"
        provider._request = Mock(return_value={"address": "oliviasmith4@sub.example.com", "token": "token"})

        provider.create_mailbox("oliviasmith4")

        payload = provider._request.call_args.kwargs["payload"]
        self.assertEqual(payload["prefix"], "oliviasmith4")


if __name__ == "__main__":
    unittest.main()
