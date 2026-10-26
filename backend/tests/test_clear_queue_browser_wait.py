import unittest

from scripts.clear_queue_browser_smoke import wait_for_fixture


class FixtureWaitTests(unittest.TestCase):
    def test_waits_for_a_real_request_later_than_the_old_100ms_assumption(self):
        class SlowPage:
            elapsed = 0
            def wait_for_timeout(self, milliseconds): self.elapsed += milliseconds
        page = SlowPage()
        wait_for_fixture(page, lambda: page.elapsed >= 500, 'delayed request', now=lambda: page.elapsed / 1000)
        self.assertEqual(page.elapsed, 500)

    def test_already_arrived_request_does_not_wait(self):
        class Page:
            def wait_for_timeout(self, milliseconds): raise AssertionError('unnecessary wait')
        wait_for_fixture(Page(), lambda: True, 'ready request')

    def test_missing_request_fails_at_a_bounded_deadline_with_context(self):
        class Page:
            elapsed = 0
            def wait_for_timeout(self, milliseconds): self.elapsed += milliseconds
        page = Page()
        with self.assertRaisesRegex(AssertionError, 'Timed out waiting for missing request'):
            wait_for_fixture(page, lambda: False, 'missing request', timeout_ms=100, now=lambda: page.elapsed / 1000)
        self.assertEqual(page.elapsed, 100)


if __name__ == '__main__': unittest.main()
