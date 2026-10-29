"""The AT-SPI checks against fake trees, no accessibility bus needed.

    python3 tests/build/test_atspi_dump.py
"""

import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("atspi_dump", os.path.join(HERE, "..", "..", "scripts", "a11y", "atspi_dump.py"))
atspi = importlib.util.module_from_spec(spec)
spec.loader.exec_module(atspi)
node = atspi.node


def app(*children, name="fundacad"):
    return node("application", name, (), [node("frame", "FundaCAD", children=children)])


def page(*children):
    return node("document web", "FundaCAD", children=children)


class Problems(unittest.TestCase):
    def test_a_named_page_passes(self):
        tree = app(page(node("push button", "Undo"), node("toggle button", "Model"), node("menu item", "Open")))
        self.assertEqual(atspi.problems([tree]), [])

    def test_a_nameless_showing_button_fails_with_its_path(self):
        found = atspi.problems([app(page(node("panel", children=[node("push button", "")])))])
        self.assertEqual(found, ['nameless push button at application "fundacad" > frame "FundaCAD" > document web "FundaCAD" > panel > push button'])

    def test_a_name_of_spaces_is_no_name(self):
        self.assertEqual(len(atspi.problems([app(page(node("push button", "  ")))])), 1)

    def test_every_named_role_is_checked(self):
        for role in atspi.NAMED_ROLES:
            with self.subTest(role=role):
                self.assertIn("nameless " + role, atspi.problems([app(page(node(role)))])[0])

    def test_a_hidden_or_defunct_nameless_button_passes(self):
        hidden = node("push button", "", ("visible",))
        gone = node("push button", "", ("showing", "defunct"))
        self.assertEqual(atspi.problems([app(page(hidden, gone))]), [])

    def test_no_document_fails(self):
        found = atspi.problems([app(node("push button", "Close"))])
        self.assertEqual(found, ["no document web node, the page never reached the accessibility bus"])

    def test_a_defunct_document_counts_as_none(self):
        dead = node("document web", "FundaCAD", ("defunct",))
        self.assertIn("no document web node", atspi.problems([app(dead)])[0])

    def test_the_document_may_sit_in_another_checked_app(self):
        shell = app(node("push button", "Close"))
        web = node("application", "WebKitWebProcess", (), [page()])
        self.assertEqual(atspi.problems([shell, web]), [])

    def test_no_app_fails(self):
        self.assertEqual(atspi.problems([]), ["no matching application on the accessibility bus"])


class Selection(unittest.TestCase):
    def test_matches_part_of_the_name_in_any_case(self):
        desktop = node("desktop frame", "main", (), [app(name="FundaCAD"), app(name="gnome-shell"), app(name="WebKitWebProcess")])
        picked = atspi.select_apps(desktop, ["fundacad", "webkit"])
        self.assertEqual([a["name"] for a in picked], ["FundaCAD", "WebKitWebProcess"])


class Format(unittest.TestCase):
    def test_indents_children_and_keeps_only_telling_states(self):
        tree = node("frame", "FundaCAD", ("showing", "visible"), [node("push button", "", ("showing", "focused"))])
        self.assertEqual(atspi.format_tree(tree), ['frame "FundaCAD" [showing]', "  push button [showing,focused]"])


class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "atspi.txt")
        self.now = [0.0]

    def tearDown(self):
        self.tmp.cleanup()

    def go(self, trees, wait=10.0):
        takes = iter(trees)
        last = [None]

        def take():
            last[0] = next(takes, last[0])
            return last[0]

        def sleep(s):
            self.now[0] += s

        return atspi.run(take, ["fundacad"], self.out, wait, 2.0, sleep=sleep, clock=lambda: self.now[0])

    def desktop(self, *apps):
        return node("desktop frame", "main", (), apps)

    def test_waits_for_the_page_then_passes(self):
        code = self.go([self.desktop(app()), self.desktop(app(page(node("push button", "Undo"))))])
        self.assertEqual(code, 0)
        self.assertEqual(self.now[0], 2.0)
        with open(self.out, encoding="utf-8") as f:
            text = f.read()
        self.assertIn('push button "Undo"', text)
        self.assertIn("checked: fundacad", text)

    def test_fails_once_the_wait_runs_out(self):
        code = self.go([self.desktop(app(page(node("push button"))))], wait=6.0)
        self.assertEqual(code, 1)
        self.assertGreaterEqual(self.now[0], 6.0)
        self.assertLess(self.now[0], 10.0)

    def test_an_absent_app_fails_and_names_what_was_there(self):
        code = self.go([self.desktop(app(name="gnome-shell"))], wait=0)
        self.assertEqual(code, 1)
        with open(self.out, encoding="utf-8") as f:
            self.assertIn("applications on the bus: gnome-shell\nchecked: none", f.read())


if __name__ == "__main__":
    unittest.main()
