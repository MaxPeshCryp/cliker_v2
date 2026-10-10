"""Currency levels use exact totals and never spend the player's balance."""
import unittest

from progression import progression, thresholds_through, REWARDS


class ProgressionTests(unittest.TestCase):
    def test_level_boundaries_and_progress(self):
        self.assertEqual(progression(0, details=True)["level"], 1)
        self.assertEqual(progression(99, details=True)["remainingExact"], "1")
        self.assertEqual(progression(100, details=True)["level"], 2)
        self.assertEqual(progression(100, details=True)["progressPercent"], 0)
        self.assertEqual(progression(170, details=True)["progressPercent"], 50)
        self.assertEqual(progression(240)["level"], 3)

    def test_every_medal_unlocks_at_its_exact_threshold(self):
        for index, badge in enumerate(REWARDS):
            threshold = int(badge["requiredEarnedExact"])
            before = progression(threshold - 1, details=True)
            after = progression(threshold, details=True)
            self.assertEqual(before["level"], badge["level"] - 1)
            self.assertEqual(before["nextBadge"]["id"], badge["id"])
            self.assertEqual(after["badge"]["id"], badge["id"])
            self.assertEqual(len(after["unlockedBadges"]), index + 1)

    def test_large_amounts_and_multi_level_jumps_have_no_precision_loss_or_cap(self):
        for level in (150, 200, 301, 600):
            threshold = thresholds_through(level)[-1]
            self.assertEqual(progression(str(threshold - 1))["level"], level - 1)
            result = progression(str(threshold), details=True)
            self.assertEqual(result["level"], level)
            self.assertEqual(result["earnedInLevelExact"], "0")
            self.assertEqual(result["totalEarnedExact"], str(threshold))
        self.assertIsNone(progression(10 ** 100, details=True)["nextBadge"])
