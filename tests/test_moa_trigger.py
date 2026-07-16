import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock

import moa_trigger


def _event():
    source = SimpleNamespace(
        platform=SimpleNamespace(value="telegram"),
        user_id="user-1",
        chat_id="chat-1",
    )
    return SimpleNamespace(text="智囊团 分析这个问题", source=source)


class _Gateway:
    def __init__(self, authorized):
        self.authorized = authorized

    def _is_user_authorized(self, source):
        return self.authorized

    def _adapter_for_source(self, source):
        return None


class MoaTriggerTests(unittest.TestCase):
    def setUp(self):
        moa_trigger._CHANNEL_ACTIVE.clear()

    def test_unauthorized_channel_user_is_not_intercepted(self):
        with mock.patch.object(moa_trigger, "_moa_configured", return_value=True):
            self.assertIsNone(moa_trigger.on_pre_gateway_dispatch(
                _event(), _Gateway(False), None
            ))

    def test_authorized_channel_run_is_bounded_and_cleaned_up(self):
        async def scenario():
            async def no_op(*args, **kwargs):
                return None
            with mock.patch.object(moa_trigger, "_moa_configured", return_value=True), \
                 mock.patch.object(moa_trigger, "_resolve_preset", return_value=None), \
                 mock.patch.object(moa_trigger, "_moa_and_reply", side_effect=no_op):
                result = moa_trigger.on_pre_gateway_dispatch(_event(), _Gateway(True), None)
                self.assertEqual(result["reason"], "decuria-moa")
                await asyncio.sleep(0)
                self.assertFalse(moa_trigger._CHANNEL_ACTIVE)
        asyncio.run(scenario())

    def _run_channel_case(self, state, preset_rounds):
        calls = []
        fake_moa = ModuleType("moa_core")
        fake_moa.run_moa = lambda *args, **kwargs: calls.append((args, kwargs)) or {
            "final_answer": "ok"
        }
        fake_moa.load_moa_config = lambda: {
            "active_preset": "default",
            "presets": {"default": {"debate_rounds": preset_rounds}},
        }

        fake_paths = ModuleType("state_paths")
        with tempfile.TemporaryDirectory() as tmp:
            state_path = Path(tmp) / "orchestrator_state.json"
            state_path.write_text(json.dumps(state), encoding="utf-8")
            fake_paths.state_file = lambda name: state_path
            with mock.patch.dict(
                sys.modules,
                {"moa_core": fake_moa, "state_paths": fake_paths},
            ):
                asyncio.run(
                    moa_trigger._moa_and_reply(
                        _Gateway(True), _event().source, None, "分析这个问题"
                    )
                )
        self.assertEqual(len(calls), 1)
        return calls[0][1]

    def test_explicit_single_round_state_never_falls_back_to_preset(self):
        kwargs = self._run_channel_case(
            {
                "debate_enabled": False,
                "debate_rounds": 1,
                "debate_auto_stop": False,
            },
            preset_rounds=3,
        )
        self.assertFalse(kwargs["debate"])
        self.assertEqual(kwargs["debate_rounds"], 1)
        self.assertFalse(kwargs["auto_stop"])

    def test_legacy_state_without_debate_fields_falls_back_to_preset(self):
        kwargs = self._run_channel_case({}, preset_rounds=3)
        self.assertTrue(kwargs["debate"])
        self.assertEqual(kwargs["debate_rounds"], 3)
        self.assertTrue(kwargs["auto_stop"])

    def test_legacy_rounds_state_still_controls_channel_mode(self):
        kwargs = self._run_channel_case({"debate_rounds": 4}, preset_rounds=2)
        self.assertTrue(kwargs["debate"])
        self.assertEqual(kwargs["debate_rounds"], 4)
        self.assertTrue(kwargs["auto_stop"])


if __name__ == "__main__":
    unittest.main()
