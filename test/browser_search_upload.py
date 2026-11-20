"""Run with python test/browser_search_upload.py and Playwright Chromium installed."""

import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from pathlib import Path
from threading import Thread
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


PUBLIC_DIR = Path(__file__).resolve().parents[1] / "public"


class StaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass


class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(StaticHandler, directory=PUBLIC_DIR))
        cls.addClassCleanup(server.server_close)
        Thread(target=server.serve_forever, daemon=True).start()
        cls.addClassCleanup(server.shutdown)
        cls.url = f"http://127.0.0.1:{server.server_port}"
        playwright = sync_playwright().start()
        cls.addClassCleanup(playwright.stop)
        cls.browser = playwright.chromium.launch()
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        context = self.browser.new_context(viewport={"width": 1024, "height": 680})
        self.addCleanup(context.close)
        self.page = context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.add_init_script("""(() => {
          localStorage.setItem('relayToken', 'fixture-token');
          window.EventSource = class extends EventTarget {
            constructor() {
              super();
              queueMicrotask(() => this.dispatchEvent(new MessageEvent('connected', {
                data: JSON.stringify({ version: '1.3.0' })
              })));
            }
            close() {}
          };
        })()""")
        self.conversations = [
            {"id": "oc_a", "name": "会话 A", "type": "group"},
            {"id": "oc_b", "name": "会话 B", "type": "group"},
        ]
        self.messages = [
            {
                "id": f"om_{index}", "chatId": "oc_b", "msgType": "text",
                "content": {"text": f"项目消息 {index}"}, "createTime": 1_800_000_000_000 + index,
            }
            for index in range(100)
        ]
        self.target = {**self.messages[29], "msgType": "file", "content": {"file_name": "项目报告.pdf"}}
        self.messages[29] = self.target
        self.history_requests = []
        self.uploads = []
        self.sends = []
        self.search_online = True
        self.history_error = None
        self.page.route("**/api/**", self.mock_api)
        self.page.goto(self.url)
        expect(self.page.get_by_text("会话 A", exact=True)).to_be_visible()
        expect(self.page.locator("#statusTx")).to_have_text("已连接")

    def tearDown(self):
        self.assertEqual(self.errors, [])

    def mock_api(self, route):
        request = route.request
        url = urlparse(request.url)
        query = parse_qs(url.query)
        payload = None
        if url.path == "/api/messages/search":
            if not self.search_online:
                route.fulfill(status=503, json={"ok": False, "error": "搜索暂不可用"})
                return
            self.assertEqual(query.get("type"), ["file"])
            payload = {"items": [self.target]}
        elif url.path.endswith("/messages"):
            self.history_requests.append((url.path, query))
            if self.history_error:
                status, message = self.history_error
                route.fulfill(status=status, json={"ok": False, "error": message})
                return
            around = query.get("around")
            items = self.messages[4:54] if around else self.messages[-50:]
            payload = {"items": items if "/oc_b/" in url.path else [], "hasNewer": bool(around)}
        elif url.path == "/api/convs":
            payload = self.conversations
        elif url.path == "/api/upload":
            name = request.headers["x-file-name"]
            self.uploads.append((name, query["kind"][0], request.post_data_buffer))
            if name == "fail.txt":
                route.fulfill(status=502, json={"ok": False, "error": "上传失败"})
                return
            if len(self.uploads) == 1:
                self.page.evaluate("selectConv('oc_b')")
            is_image = query["kind"] == ["image"]
            route.fulfill(json={
                "ok": True, "content": {"image_key" if is_image else "file_key": "fixture"},
                "msgType": "image" if is_image else "file", "fileName": name,
            })
            return
        elif url.path == "/api/send":
            self.sends.append(request.post_data_json)
        route.fulfill(json={"ok": True, "data": payload if payload is not None else {}})

    def search_for_report(self):
        page = self.page
        page.keyboard.press("Control+f")
        page.locator("#searchType").select_option("file")
        page.locator("#searchInput").fill("报告")
        return page.locator(".search-result").filter(has_text="项目报告.pdf")

    def test_cross_chat_search_centers_older_message_and_returns_to_latest(self):
        page = self.page
        page.get_by_text("会话 A", exact=True).click()
        expect(page.locator("#hdName")).to_have_text("会话 A")
        self.search_for_report().click()
        expect(page.locator("#hdName")).to_have_text("会话 B")
        target = page.locator('[data-msg-id="om_29"]')
        expect(target).to_have_class("msg in search-target")
        expect(target).to_be_in_viewport()
        expect(page.locator('[data-msg-id="om_28"]')).to_be_attached()
        expect(page.locator('[data-msg-id="om_30"]')).to_be_attached()
        self.assertEqual(self.history_requests[-1][1]["around"], ["om_29"])
        page.locator("#scrollToBottom").click()
        expect(page.locator('[data-msg-id="om_99"]')).to_be_in_viewport()
        self.assertNotIn("around", self.history_requests[-1][1])

    def test_withdrawn_search_result_keeps_current_chat_open(self):
        page = self.page
        page.get_by_text("会话 A", exact=True).click()
        expect(page.locator("#hdName")).to_have_text("会话 A")
        result = self.search_for_report()
        self.history_error = (404, "这条消息已不存在或已被撤回")
        result.click()
        expect(page.get_by_text("这条消息已不存在或已被撤回")).to_be_visible()
        expect(page.locator("#hdName")).to_have_text("会话 A")
        expect(result).to_be_visible()

    def test_failed_return_to_latest_preserves_history_and_can_retry(self):
        page = self.page
        self.search_for_report().click()
        target = page.locator('[data-msg-id="om_29"]')
        expect(target).to_be_in_viewport()
        self.history_error = (503, "历史暂不可用")
        latest = page.get_by_role("button", name="返回最新消息")
        latest.click()
        expect(page.get_by_text("历史暂不可用")).to_be_visible()
        expect(target).to_be_in_viewport()
        self.history_error = None
        latest.click()
        expect(page.locator('[data-msg-id="om_99"]')).to_be_in_viewport()

    def test_local_fallback_keeps_type_filter_and_jumps(self):
        page = self.page
        page.set_viewport_size({"width": 390, "height": 700})
        page.get_by_text("会话 B", exact=True).click()
        expect(page.locator("#hdName")).to_have_text("会话 B")
        self.search_online = False
        page.keyboard.press("Control+f")
        page.locator("#searchType").select_option("file")
        page.locator("#searchInput").fill("项目消息 65")
        expect(page.locator("#searchStatus")).to_contain_text("0 条结果")
        page.locator("#searchType").select_option("message")
        page.locator("#searchInput").fill("项目消息 65")
        expect(page.locator(".search-result")).to_have_count(1)
        expect(page.locator(".search-result mark")).to_have_text("项目消息 65")
        page.locator(".search-result").click()
        expect(page.locator('[data-msg-id="om_65"]')).to_be_in_viewport()

    def test_drop_uploads_sequentially_and_keeps_original_recipient(self):
        page = self.page
        data = page.evaluate_handle("""() => {
          const transfer = new DataTransfer();
          transfer.items.add(new File(['report'], 'report.txt', { type: 'text/plain' }));
          transfer.items.add(new File(['picture'], 'image.png', { type: 'image/png' }));
          return transfer;
        }""")
        page.locator("#empty").dispatch_event("drop", {"dataTransfer": data})
        expect(page.get_by_text("请先选择会话，再发送附件")).to_be_visible()
        self.assertEqual(self.uploads, [])
        page.get_by_text("会话 A", exact=True).click()
        expect(page.locator("#hdName")).to_have_text("会话 A")
        page.locator("#msgs").dispatch_event("dragover", {"dataTransfer": data})
        expect(page.locator("#chat")).to_have_class("chat dragging-files")
        page.locator("#input").dispatch_event("drop", {"dataTransfer": data})
        expect(page.get_by_text("image.png 已发送", exact=True)).to_be_visible()
        expect(page.locator("#chat")).to_have_class("chat")
        expect(page.locator("#hdName")).to_have_text("会话 B")
        self.assertEqual(self.uploads, [("report.txt", "file", b"report"), ("image.png", "image", b"picture")])
        self.assertEqual([(item["chatId"], item["msgType"]) for item in self.sends], [("oc_a", "file"), ("oc_a", "image")])

    def test_failed_upload_does_not_send_and_next_file_still_works(self):
        page = self.page
        page.get_by_text("会话 A", exact=True).click()
        expect(page.locator("#hdName")).to_have_text("会话 A")
        data = page.evaluate_handle("""() => {
          const transfer = new DataTransfer();
          for (const name of ['empty.txt', 'fail.txt', 'pass.txt']) {
            const text = name === 'empty.txt' ? '' : name;
            transfer.items.add(new File([text], name, { type: 'text/plain' }));
          }
          return transfer;
        }""")
        page.locator("#msgs").dispatch_event("drop", {"dataTransfer": data})
        expect(page.get_by_text("fail.txt：上传失败", exact=True)).to_be_visible()
        expect(page.get_by_text("pass.txt 已发送", exact=True)).to_be_visible()
        expect(page.locator("#attachBtn")).to_be_enabled()
        self.assertEqual([upload[0] for upload in self.uploads], ["fail.txt", "pass.txt"])
        self.assertEqual([item["fileName"] for item in self.sends], ["pass.txt"])


if __name__ == "__main__":
    unittest.main()
