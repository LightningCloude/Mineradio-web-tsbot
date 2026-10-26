from pathlib import Path
import unittest

import yaml


class NativeBuildWorkflowTests(unittest.TestCase):
    def test_native_test_and_package_keep_locked_dependencies_and_cmake_compatibility(self):
        workflow = yaml.safe_load((Path(__file__).resolve().parents[2] / '.github/workflows/docker-publish.yml').read_text(encoding='utf-8'))
        native_steps = [step for job in workflow['jobs'].values() for step in job['steps']
                        if 'cargo test ' in step.get('run', '') or 'cargo build ' in step.get('run', '')]
        self.assertEqual(len(native_steps), 2)
        for step in native_steps:
            self.assertEqual(step['env']['CMAKE_POLICY_VERSION_MINIMUM'], '3.5')
            self.assertIn('--locked', step['run'])
        steps = workflow['jobs']['validate']['steps']
        native_index = next(index for index, step in enumerate(steps) if step['name'] == 'Test voice-service with locked dependencies')
        browser_index = next(index for index, step in enumerate(steps) if step['name'].startswith('Smoke test built web'))
        self.assertLess(native_index, browser_index, 'Fail native builds before expensive browser checks')
        self.assertTrue(any(step.get('run') == 'npm --prefix web audit --registry=https://registry.npmjs.org' for step in steps))


if __name__ == '__main__': unittest.main()
