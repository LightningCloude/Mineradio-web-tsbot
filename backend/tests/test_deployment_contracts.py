from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]


class WebDeploymentContractTests(unittest.TestCase):
    def test_web_image_uses_the_checked_nginx_config(self):
        dockerfile = (REPO_ROOT / "Dockerfile.web").read_text(encoding="utf-8")
        self.assertIn(
            "COPY docker/nginx-web.conf /etc/nginx/conf.d/default.conf",
            dockerfile,
        )
        dist_dockerfile = (REPO_ROOT / "Dockerfile.web-dist").read_text(
            encoding="utf-8"
        )
        self.assertIn(
            "COPY docker/nginx-web.conf /etc/nginx/conf.d/default.conf",
            dist_dockerfile,
        )
        self.assertIn(
            "COPY web/dist /usr/share/nginx/html",
            dist_dockerfile,
        )

    def test_web_nginx_proxies_api_admin_websocket_and_covers(self):
        config = (REPO_ROOT / "docker" / "nginx-web.conf").read_text(encoding="utf-8")

        self.assertIn("location /api/", config)
        self.assertIn("proxy_pass http://backend:8009/;", config)
        self.assertIn("location /admin/", config)
        self.assertIn("proxy_pass http://backend:8009;", config)
        self.assertIn("location /ws/", config)
        self.assertIn("proxy_set_header Upgrade $http_upgrade;", config)
        self.assertIn("location /cover/", config)
        self.assertIn("proxy_ssl_server_name on;", config)
        self.assertNotIn("resolver 8.8.8.8", config)

    def test_vite_dev_and_preview_keep_the_runtime_proxy_contract(self):
        config = (REPO_ROOT / "web" / "vite.config.js").read_text(
            encoding="utf-8"
        )

        self.assertIn("'/api': apiProxy", config)
        self.assertIn("'/admin': adminProxy", config)
        self.assertIn("'/ws': wsProxy", config)
        self.assertIn("'/cover': coverProxy", config)
        self.assertIn("path.replace(/^\\/cover\\//, '/music/photo_new/')", config)
        self.assertIn("TSBOT_WEB_PROXY_PRESERVE_API_PREFIX", config)

    def test_acceptance_wrappers_delegate_to_the_read_only_verifier(self):
        shell_wrapper = (REPO_ROOT / "verify-deployment.sh").read_text(
            encoding="utf-8"
        )
        powershell_wrapper = (REPO_ROOT / "verify-deployment.ps1").read_text(
            encoding="utf-8"
        )
        verifier = (REPO_ROOT / "scripts" / "verify_deployment.py").read_text(
            encoding="utf-8"
        )

        self.assertIn("scripts/verify_deployment.py", shell_wrapper)
        self.assertIn("scripts/verify_deployment.py", powershell_wrapper)
        self.assertIn('method="GET"', verifier)
        self.assertNotIn('method="POST"', verifier)
        self.assertNotIn('method="PUT"', verifier)
        self.assertNotIn('method="DELETE"', verifier)

    def test_release_wrappers_delegate_to_the_safe_web_deployer(self):
        shell_wrapper = (REPO_ROOT / "deploy-web.sh").read_text(encoding="utf-8")
        powershell_wrapper = (REPO_ROOT / "deploy-web.ps1").read_text(
            encoding="utf-8"
        )
        deployer = (REPO_ROOT / "scripts" / "deploy_web.py").read_text(
            encoding="utf-8"
        )

        self.assertIn("scripts/deploy_web.py", shell_wrapper)
        self.assertIn("scripts/deploy_web.py", powershell_wrapper)
        self.assertIn('"--execute"', deployer)
        self.assertIn('"--no-deps", "web"', deployer)

        drill_shell = (REPO_ROOT / "drill-web-deployment.sh").read_text(
            encoding="utf-8"
        )
        drill_powershell = (REPO_ROOT / "drill-web-deployment.ps1").read_text(
            encoding="utf-8"
        )
        self.assertIn("scripts/drill_web_deployment.py", drill_shell)
        self.assertIn("scripts/drill_web_deployment.py", drill_powershell)


if __name__ == "__main__":
    unittest.main()
