#!/usr/bin/env python3
"""
Converts one Office document to PDF with LibreOffice, applying print settings.

Contract (so the API can run this natively or via `docker exec -i`):
  stdin   the document bytes
  stdout  the resulting PDF bytes
  stderr  diagnostics; a line "PP_ERROR:<code>" explains a failure
  args    --family writer|calc|impress  --ext docx  --settings <base64url JSON>  --timeout 90
Exit codes: 0 ok, 2 document could not be opened (damaged or password-protected), 3 timeout, 1 other.

Each run starts its own LibreOffice with a throw-away profile, so runs never share state.
"""
import argparse
import base64
import json
import os
import random
import shutil
import signal
import subprocess
import sys
import tempfile
import time

import uno
from com.sun.star.beans import PropertyValue

PAPER_MM100 = {"A4": (21000, 29700), "A3": (29700, 42000)}
MARGIN_MM100 = {"narrow": 1000, "none": 0}


def pv(name, value):
    p = PropertyValue()
    p.Name = name
    p.Value = value
    return p


def fail(code, exit_code):
    sys.stderr.write("PP_ERROR:%s\n" % code)
    sys.stderr.flush()
    sys.exit(exit_code)


def apply_page_settings(doc, settings, calc):
    """Sets paper size, orientation, margins (and spreadsheet scaling) on every page style."""
    styles = doc.StyleFamilies.getByName("PageStyles")
    paper = PAPER_MM100.get(settings.get("paperSize", "A4"), PAPER_MM100["A4"])
    orientation = settings.get("orientation", "auto")
    margins = settings.get("margins", "document")
    fit = settings.get("fit", "fit_width")

    for name in styles.getElementNames():
        style = styles.getByName(name)
        landscape = style.IsLandscape if orientation == "auto" else orientation == "landscape"
        short, long_ = paper
        width, height = (long_, short) if landscape else (short, long_)
        style.IsLandscape = landscape
        style.Width = width
        style.Height = height
        if margins in MARGIN_MM100:
            m = MARGIN_MM100[margins]
            style.LeftMargin = m
            style.RightMargin = m
            style.TopMargin = m
            style.BottomMargin = m
        if calc:
            style.PrintGrid = bool(settings.get("gridlines", False))
            if fit == "fit_width":
                style.ScaleToPagesX = 1
                style.ScaleToPagesY = 0
            elif fit == "one_page_per_sheet":
                style.ScaleToPagesX = 1
                style.ScaleToPagesY = 1


def export_filter(family, settings):
    if family == "writer":
        return "writer_pdf_Export", []
    if family == "calc":
        return "calc_pdf_Export", []
    data = [pv("ExportHiddenSlides", bool(settings.get("includeHiddenSlides", False)))]
    if settings.get("includeNotes", False):
        data += [pv("ExportNotesPages", True), pv("ExportOnlyNotesPages", True)]
    return "impress_pdf_Export", data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--family", required=True, choices=["writer", "calc", "impress"])
    parser.add_argument("--ext", required=True)
    parser.add_argument("--settings", default="e30")  # base64url of {}
    parser.add_argument("--timeout", type=int, default=90)
    args = parser.parse_args()

    padded = args.settings + "=" * (-len(args.settings) % 4)
    settings = json.loads(base64.urlsafe_b64decode(padded) or b"{}")

    workdir = tempfile.mkdtemp(prefix="pp-convert-")
    proc = None

    def cleanup():
        if proc is not None and proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
        shutil.rmtree(workdir, ignore_errors=True)

    def on_alarm(_signum, _frame):
        cleanup()
        fail("timeout", 3)

    signal.signal(signal.SIGALRM, on_alarm)
    signal.alarm(args.timeout)

    try:
        src = os.path.join(workdir, "input." + args.ext)
        out = os.path.join(workdir, "output.pdf")
        with open(src, "wb") as f:
            f.write(sys.stdin.buffer.read())

        pipe = "pp%08x" % random.getrandbits(32)
        proc = subprocess.Popen(
            [
                "soffice", "--headless", "--invisible", "--nologo", "--norestore",
                "--nodefault", "--nofirststartwizard",
                "-env:UserInstallation=" + uno.systemPathToFileUrl(os.path.join(workdir, "profile")),
                "--accept=pipe,name=%s;urp;" % pipe,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext(
            "com.sun.star.bridge.UnoUrlResolver", local
        )
        ctx = None
        for _ in range(120):
            try:
                ctx = resolver.resolve("uno:pipe,name=%s;urp;StarOffice.ComponentContext" % pipe)
                break
            except Exception:
                if proc.poll() is not None:
                    fail("office_crashed", 1)
                time.sleep(0.5)
        if ctx is None:
            fail("office_unavailable", 1)

        desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
        try:
            doc = desktop.loadComponentFromURL(
                uno.systemPathToFileUrl(src),
                "_blank",
                0,
                (
                    pv("Hidden", True),
                    pv("ReadOnly", True),
                    pv("MacroExecutionMode", 0),  # NEVER_EXECUTE
                    pv("UpdateDocMode", 0),  # NO_UPDATE: do not refresh links
                ),
            )
        except Exception as exc:  # unreadable, or password-protected
            sys.stderr.write("load failed: %s\n" % exc)
            fail("unreadable", 2)
        if doc is None:
            fail("unreadable", 2)

        if args.family in ("writer", "calc"):
            apply_page_settings(doc, settings, args.family == "calc")

        filter_name, filter_data = export_filter(args.family, settings)
        store = [pv("FilterName", filter_name)]
        if filter_data:
            store.append(
                pv("FilterData", uno.Any("[]com.sun.star.beans.PropertyValue", tuple(filter_data)))
            )
        doc.storeToURL(uno.systemPathToFileUrl(out), tuple(store))
        doc.close(True)
        try:
            desktop.terminate()
        except Exception:
            pass

        with open(out, "rb") as f:
            sys.stdout.buffer.write(f.read())
        sys.stdout.buffer.flush()
    finally:
        cleanup()


if __name__ == "__main__":
    main()
