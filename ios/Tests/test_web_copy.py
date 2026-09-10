"""Exercise the Web ICU to Apple catalog boundary without Xcode or a simulator."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from web_copy import copy_errors, expected_copy, localization


class WebCopyTests(unittest.TestCase):
    def test_named_arguments_keep_swift_order(self):
        value = localization("{new} replaces {old}", {"old": "@", "new": "@"})
        self.assertEqual(value["stringUnit"]["value"], "%2$@ replaces %1$@")

    def test_count_and_english_plural_forms(self):
        english = localization("{count, plural, one {# session} other {# sessions}}", {"count": "lld"}, "count")
        chinese = localization("{count} 个会话", {"count": "lld"}, "count")
        self.assertEqual(english["variations"]["plural"]["one"]["stringUnit"]["value"], "%lld session")
        self.assertEqual(english["variations"]["plural"]["other"]["stringUnit"]["value"], "%lld sessions")
        self.assertEqual(chinese["variations"]["plural"]["other"]["stringUnit"]["value"], "%lld 个会话")

    def test_new_or_complex_placeholders_require_review(self):
        for text in ["Connect {device}", "{count, plural, zero {None} one {#} other {#}}"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                localization(text)

    def test_translation_drift_is_reported(self):
        expected = expected_copy()
        self.assertFalse(list(copy_errors(expected, expected)))
        changed = dict(expected)
        changed["Close"] = {"localizations": {"en": localization("Dismiss")}}
        errors = list(copy_errors(changed, expected))
        self.assertEqual(len(errors), 2)
        self.assertTrue(all("'Close'" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
