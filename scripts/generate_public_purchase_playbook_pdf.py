#!/usr/bin/env python3
"""Generate the private admin-only alphaScreen public purchase support playbook PDF."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Sequence

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "templates" / "pdf" / "alphascreen-public-purchase-support-playbook.pdf"

PAGE_WIDTH, PAGE_HEIGHT = landscape(letter)

NAVY = colors.HexColor("#0A1547")
TEXT = colors.HexColor("#273454")
MUTED = colors.HexColor("#7580A0")
BG = colors.HexColor("#F4F2FB")
PANEL = colors.HexColor("#FFFFFF")
PANEL_SOFT = colors.HexColor("#F7F4FF")
BORDER = colors.HexColor("#DDE2F0")
PURPLE = colors.HexColor("#9A70F4")
TEAL = colors.HexColor("#05D1B2")
BLUE = colors.HexColor("#08A8D8")
AMBER = colors.HexColor("#F6C45F")
RED = colors.HexColor("#E85D75")
MINT_SOFT = colors.HexColor("#E9FBF7")
AMBER_SOFT = colors.HexColor("#FFF6DF")
RED_SOFT = colors.HexColor("#FFF0F3")
BLUE_SOFT = colors.HexColor("#EAF7FC")


def clean(text: str) -> str:
    """Keep generated PDF text ASCII-friendly and avoid smart punctuation."""
    replacements = {
        "\u2014": "-",
        "\u2013": "-",
        "\u2011": "-",
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2022": "-",
        "\u203a": ">",
    }
    for source, target in replacements.items():
        text = text.replace(source, target)
    return text


def width(text: str, font: str, size: float) -> float:
    return pdfmetrics.stringWidth(clean(text), font, size)


def wrap_text(text: str, font: str, size: float, max_width: float) -> list[str]:
    words = clean(text).split()
    if not words:
        return []
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if width(candidate, font, size) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def draw_text(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    *,
    size: float = 10,
    font: str = "Helvetica",
    color=TEXT,
    max_width: float | None = None,
    leading: float | None = None,
) -> float:
    c.setFont(font, size)
    c.setFillColor(color)
    if max_width is None:
        c.drawString(x, y, clean(text))
        return y - (leading or size + 3)
    line_height = leading or size + 4
    for line in wrap_text(text, font, size, max_width):
        c.drawString(x, y, line)
        y -= line_height
    return y


def draw_centered(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    max_width: float,
    *,
    size: float = 10,
    font: str = "Helvetica-Bold",
    color=TEXT,
) -> None:
    c.setFont(font, size)
    c.setFillColor(color)
    lines = wrap_text(text, font, size, max_width)
    line_height = size + 3
    total = line_height * (len(lines) - 1)
    for index, line in enumerate(lines):
        line_width = width(line, font, size)
        c.drawString(x + (max_width - line_width) / 2, y - index * line_height + total / 2, line)


def rounded_rect(c: canvas.Canvas, x: float, y: float, w: float, h: float, radius: float = 12, *, fill=PANEL, stroke=BORDER, line_width: float = 1) -> None:
    c.setLineWidth(line_width)
    c.setStrokeColor(stroke)
    c.setFillColor(fill)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


def draw_footer(c: canvas.Canvas, page_number: int, total_pages: int) -> None:
    c.setStrokeColor(colors.HexColor("#D9DEEA"))
    c.setLineWidth(0.7)
    c.line(46, 34, PAGE_WIDTH - 46, 34)
    draw_text(c, "alphaScreen public purchase support playbook", 46, 20, size=8, font="Helvetica-Bold", color=MUTED)
    label = f"{page_number:02d} / {total_pages:02d}"
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(MUTED)
    c.drawRightString(PAGE_WIDTH - 46, 20, label)


def draw_header(c: canvas.Canvas, page_number: int, title: str, label: str, total_pages: int) -> None:
    c.setFillColor(BG)
    c.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    rounded_rect(c, 46, 532, 38, 38, 9, fill=NAVY, stroke=NAVY)
    draw_centered(c, f"{page_number:02d}", 46, 550, 38, size=14, font="Helvetica-Bold", color=colors.white)
    draw_text(c, "ALPHASCREEN BY ALPHASOURCE", 96, 564, size=8.5, font="Helvetica-Bold", color=MUTED)
    draw_text(c, title, 96, 540, size=21, font="Helvetica-Bold", color=NAVY, max_width=470, leading=24)
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(MUTED)
    for index, line in enumerate(label.split(" / ")):
        c.drawRightString(PAGE_WIDTH - 70, 560 - index * 15, clean(line))
    draw_footer(c, page_number, total_pages)


def draw_badge(c: canvas.Canvas, text: str, x: float, y: float, *, fill=PURPLE, text_color=colors.white, font_size: float = 9, min_width: float = 0) -> float:
    pad_x = 18
    badge_w = max(min_width, width(text, "Helvetica-Bold", font_size) + pad_x * 2)
    rounded_rect(c, x, y, badge_w, 26, 13, fill=fill, stroke=fill)
    c.setFont("Helvetica-Bold", font_size)
    c.setFillColor(text_color)
    c.drawCentredString(x + badge_w / 2, y + 8, clean(text))
    return badge_w


def draw_callout(c: canvas.Canvas, title: str, body: str, x: float, y: float, w: float, h: float, *, accent=PURPLE, fill=PANEL_SOFT) -> None:
    rounded_rect(c, x, y, w, h, 12, fill=fill, stroke=fill)
    c.setFillColor(accent)
    c.roundRect(x, y, 4, h, 2, fill=1, stroke=0)
    draw_text(c, title.upper(), x + 18, y + h - 20, size=7.5, font="Helvetica-Bold", color=accent)
    draw_text(c, body, x + 18, y + h - 39, size=10, font="Helvetica-Bold", color=NAVY, max_width=w - 34, leading=13)


def draw_card(
    c: canvas.Canvas,
    title: str,
    body: str,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    accent=PURPLE,
    fill=PANEL,
    title_size: float = 11,
    body_size: float = 8.5,
) -> None:
    rounded_rect(c, x, y, w, h, 11, fill=fill, stroke=BORDER)
    c.setFillColor(accent)
    c.roundRect(x, y + h - 4, w, 4, 2, fill=1, stroke=0)
    draw_text(c, title, x + 15, y + h - 24, size=title_size, font="Helvetica-Bold", color=NAVY, max_width=w - 30, leading=13)
    draw_text(c, body, x + 15, y + h - 48, size=body_size, color=MUTED, max_width=w - 30, leading=11.5)


def draw_numbered_item(c: canvas.Canvas, number: int, title: str, body: str, x: float, y: float, w: float) -> float:
    c.setFillColor(NAVY)
    c.circle(x + 9, y - 5, 9, fill=1, stroke=0)
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(colors.white)
    c.drawCentredString(x + 9, y - 8, str(number))
    draw_text(c, title, x + 28, y, size=11, font="Helvetica-Bold", color=NAVY, max_width=w - 28, leading=13)
    return draw_text(c, body, x + 28, y - 15, size=8.8, color=MUTED, max_width=w - 28, leading=11) - 5


def draw_flow(c: canvas.Canvas, labels: Sequence[str], x: float, y: float, max_width: float, *, active_index: int = 0) -> None:
    cursor_x = x
    cursor_y = y
    for index, label in enumerate(labels):
        chip_w = max(78, min(148, width(label, "Helvetica-Bold", 8.2) + 26))
        if cursor_x + chip_w > x + max_width:
            cursor_x = x
            cursor_y -= 35
        fill = PURPLE if index == active_index else PANEL
        stroke = PURPLE if index == active_index else BORDER
        text_color = colors.white if index == active_index else NAVY
        rounded_rect(c, cursor_x, cursor_y, chip_w, 26, 13, fill=fill, stroke=stroke)
        draw_centered(c, label, cursor_x + 4, cursor_y + 13, chip_w - 8, size=8.2, font="Helvetica-Bold", color=text_color)
        cursor_x += chip_w + 10
        if index < len(labels) - 1:
            c.setFont("Helvetica-Bold", 10)
            c.setFillColor(MUTED)
            c.drawString(cursor_x - 4, cursor_y + 8, ">")
            cursor_x += 12


def draw_bullets(c: canvas.Canvas, items: Iterable[str], x: float, y: float, w: float, *, bullet_color=PURPLE, size: float = 9.2, gap: float = 12) -> float:
    current_y = y
    for item in items:
        c.setFillColor(bullet_color)
        c.circle(x + 3, current_y - 3, 3, fill=1, stroke=0)
        new_y = draw_text(c, item, x + 15, current_y, size=size, color=TEXT, max_width=w - 15, leading=size + 3.5)
        current_y = new_y - gap
    return current_y


def draw_table(c: canvas.Canvas, x: float, y: float, w: float, headers: Sequence[str], rows: Sequence[Sequence[str]], col_widths: Sequence[float], *, row_height: float = 45) -> float:
    header_h = 28
    rounded_rect(c, x, y - header_h, w, header_h, 10, fill=NAVY, stroke=NAVY)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 7.8)
    col_x = x
    for header, col_w in zip(headers, col_widths):
        c.drawString(col_x + 10, y - 18, clean(header).upper())
        col_x += col_w
    current_y = y - header_h
    for row_index, row in enumerate(rows):
        fill = colors.white if row_index % 2 == 0 else colors.HexColor("#F8F9FD")
        c.setFillColor(fill)
        c.roundRect(x, current_y - row_height, w, row_height, 4, fill=1, stroke=0)
        c.setStrokeColor(BORDER)
        c.line(x, current_y - row_height, x + w, current_y - row_height)
        col_x = x
        for cell, col_w in zip(row, col_widths):
            draw_text(c, cell, col_x + 10, current_y - 14, size=7.4, color=TEXT, max_width=col_w - 18, leading=9.5)
            col_x += col_w
        current_y -= row_height
    return current_y


def draw_dashboard_placeholder(c: canvas.Canvas, x: float, y: float, w: float, h: float) -> None:
    rounded_rect(c, x, y, w, h, 14, fill=colors.white, stroke=BORDER)
    c.setFillColor(colors.HexColor("#F6F2FF"))
    c.rect(x + 1, y + 1, 88, h - 2, fill=1, stroke=0)
    c.setFillColor(TEAL)
    c.circle(x + 17, y + h - 19, 5, fill=1, stroke=0)
    draw_text(c, "Admin", x + 31, y + h - 16, size=6.2, font="Helvetica-Bold", color=MUTED)
    nav_items = ["Purchases", "Analytics", "Metrics", "Support"]
    for index, item in enumerate(nav_items):
        item_y = y + h - 47 - index * 24
        rounded_rect(c, x + 14, item_y, 58, 13, 6, fill=colors.HexColor("#EDE7FF") if index == 0 else colors.white, stroke=colors.HexColor("#EDE7FF"))
        draw_text(c, item, x + 21, item_y + 4, size=4.8, font="Helvetica-Bold", color=NAVY if index == 0 else MUTED)
    draw_text(c, "Admin Public Purchases", x + 112, y + h - 42, size=10, font="Helvetica-Bold", color=NAVY)
    for i, (label, value, accent) in enumerate([
        ("Started", "18", PURPLE),
        ("Agreement", "4", AMBER),
        ("Setup", "2", BLUE),
    ]):
        card_x = x + 112 + i * 78
        rounded_rect(c, card_x, y + h - 92, 66, 45, 8, fill=colors.white, stroke=BORDER)
        draw_text(c, label, card_x + 8, y + h - 63, size=5.8, font="Helvetica-Bold", color=MUTED)
        draw_text(c, value, card_x + 8, y + h - 82, size=15, font="Helvetica-Bold", color=NAVY)
        c.setFillColor(accent)
        c.circle(card_x + 52, y + h - 66, 5, fill=1, stroke=0)
    for index in range(4):
        row_y = y + 28 + index * 21
        c.setStrokeColor(colors.HexColor("#ECF0F7"))
        c.line(x + 112, row_y, x + w - 24, row_y)
        rounded_rect(c, x + 112, row_y + 5, 82, 8, 4, fill=colors.HexColor("#F0F3FA"), stroke=colors.HexColor("#F0F3FA"))
        rounded_rect(c, x + 216, row_y + 5, 44, 8, 4, fill=colors.HexColor("#F0F3FA"), stroke=colors.HexColor("#F0F3FA"))
        rounded_rect(c, x + 286, row_y + 5, 64, 8, 4, fill=colors.HexColor("#F0F3FA"), stroke=colors.HexColor("#F0F3FA"))


def draw_scenario_card(
    c: canvas.Canvas,
    title: str,
    symptoms: Sequence[str],
    action: str,
    avoid: str,
    wording: str,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    accent=PURPLE,
) -> None:
    rounded_rect(c, x, y, w, h, 12, fill=PANEL, stroke=BORDER)
    c.setFillColor(accent)
    c.roundRect(x, y + h - 4, w, 4, 2, fill=1, stroke=0)
    draw_text(c, title, x + 16, y + h - 24, size=12, font="Helvetica-Bold", color=NAVY, max_width=w - 32)
    draw_text(c, "Symptoms", x + 16, y + h - 51, size=7.5, font="Helvetica-Bold", color=MUTED)
    cursor_y = draw_bullets(c, symptoms, x + 18, y + h - 66, w - 32, bullet_color=accent, size=7.5, gap=3)
    draw_text(c, "Support action", x + 16, cursor_y, size=7.5, font="Helvetica-Bold", color=MUTED)
    cursor_y = draw_text(c, action, x + 16, cursor_y - 13, size=8, color=TEXT, max_width=w - 32, leading=10.2)
    draw_callout(c, "Do not", avoid, x + 16, y + 50, w - 32, 43, accent=RED, fill=RED_SOFT)
    draw_text(c, "Suggested wording", x + 16, y + 34, size=7.5, font="Helvetica-Bold", color=MUTED)
    draw_text(c, wording, x + 16, y + 21, size=7.2, color=TEXT, max_width=w - 32, leading=9)


def draw_cover(c: canvas.Canvas, total_pages: int) -> None:
    c.setFillColor(BG)
    c.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
    draw_text(c, "alphaScreen by alphaSource", 48, 520, size=12, color=TEXT)
    draw_badge(c, "ADMIN ONLY", 646, 524, fill=NAVY, font_size=8.5, min_width=92)
    draw_text(c, "alphaScreen Public Purchase", 48, 474, size=30, font="Helvetica-Bold", color=NAVY)
    draw_text(c, "Support Playbook", 48, 439, size=30, font="Helvetica-Bold", color=NAVY)
    draw_text(
        c,
        "Internal support guide for self-serve alphaScreen membership purchases.",
        48,
        405,
        size=13,
        color=MUTED,
        max_width=610,
    )
    draw_callout(
        c,
        "Support standard",
        "Every purchase row should be triaged from Admin Public Purchases. Do not manually mark agreements, payments, billing, or account activation outside an approved escalation.",
        48,
        335,
        650,
        58,
        accent=PURPLE,
        fill=PANEL_SOFT,
    )
    card_w = 210
    draw_card(c, "Source of truth", "Use Admin Public Purchases to review agreement, checkout, setup, and email state.", 48, 220, card_w, 82, accent=TEAL)
    draw_card(c, "Recovery actions", "Resend the correct agreement, checkout, setup, or welcome email only when the row allows it.", 286, 220, card_w, 82, accent=PURPLE)
    draw_card(c, "Escalation boundary", "Do not manually change agreement, payment, billing, or account activation state.", 524, 220, card_w, 82, accent=BLUE)
    draw_text(c, "PUBLIC PURCHASE FLOW", 48, 155, size=8.5, font="Helvetica-Bold", color=NAVY)
    draw_flow(
        c,
        ["Pricing", "Signup", "Agreement", "Checkout", "Activation", "Setup", "Dashboard"],
        48,
        118,
        690,
        active_index=0,
    )
    draw_footer(c, 1, total_pages)


def page_support_scope(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 2, "What support can resolve", "SIX TASKS / ONE SOURCE", total_pages)
    draw_text(c, "Use the admin page to find the buyer's current state, choose the next safe recovery action, and escalate mismatches without exposing private system data.", 46, 495, size=10.5, color=MUTED, max_width=700)
    draw_dashboard_placeholder(c, 46, 292, 456, 172)
    y = 452
    for index, (title, body) in enumerate([
        ("Find current state", "Review agreement, checkout, setup, and email signals in one row."),
        ("Resume safely", "Use the allowed resend action for the step the buyer is actually in."),
        ("Avoid manual mutation", "Do not mark agreements, payments, billing, or activation by hand."),
        ("Escalate mismatches", "Copy a sanitized support summary when status signals conflict."),
        ("Use safe wording", "Give the next step without sharing private links or provider data."),
    ], start=1):
        y = draw_numbered_item(c, index, title, body, 532, y, 210)
    draw_callout(
        c,
        "Support action",
        "If the row is not clearly complete, describe the current state and next safe step. Do not promise activation, refund, cancellation, or billing changes without confirmation.",
        46,
        122,
        700,
        80,
        accent=TEAL,
        fill=MINT_SOFT,
    )


def page_lifecycle(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 3, "Public purchase lifecycle", "SEVEN STAGES / TWO GATES", total_pages)
    draw_text(c, "Agreement signing gates checkout. Stripe confirmation gates setup and dashboard access.", 46, 500, size=11, color=MUTED, max_width=690)
    draw_flow(
        c,
        ["Pricing", "Signup", "Agreement", "Stripe Checkout", "Activation", "Setup email", "Dashboard"],
        46,
        450,
        700,
        active_index=0,
    )
    draw_bullets(
        c,
        [
            "Help the buyer resume the next safe step for the current row state.",
            "Do not skip agreement signing, bypass Stripe Checkout, or override webhook activation.",
            "Password setup and dashboard access only follow confirmed activation and member linking.",
        ],
        46,
        370,
        700,
        bullet_color=PURPLE,
        size=10,
        gap=14,
    )
    draw_text(c, "WHERE THE WORK LIVES", 46, 228, size=8.5, font="Helvetica-Bold", color=NAVY)
    c.setStrokeColor(TEAL)
    c.setLineWidth(1.5)
    c.line(46, 217, 746, 217)
    stage_cards = [
        ("Buyer details", "Name, company, membership, cadence, and source path."),
        ("Agreement", "Sent, opened, signed, and checkout gating state."),
        ("Checkout", "Stripe payment and return-state indicators."),
        ("Setup", "Client, member, password setup, and welcome email state."),
    ]
    for index, (title, body) in enumerate(stage_cards):
        draw_card(c, title, body, 46 + index * 176, 120, 154, 72, accent=[TEAL, PURPLE, BLUE, AMBER][index], title_size=10, body_size=8)


def page_quick_reference(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 4, "Admin Public Purchases quick reference", "STATUS TRIAGE / CORRECT ACTION", total_pages)
    rows = [
        ("Agreement pending", "Agreement not signed yet.", "Resend agreement link if available.", "Agreement only"),
        ("Signed / checkout pending", "Agreement signed; payment unpaid or in progress.", "Resend checkout link after confirming no paid state.", "Checkout only"),
        ("Setup pending", "Payment appears complete; setup or member linking incomplete.", "Resend setup email if available; escalate if stuck.", "Setup only"),
        ("Completed", "Billing and member access are active and linked.", "Guide buyer to login or resend welcome email if needed.", "Login/support"),
        ("Canceled / failed", "Payment failed, expired, or purchase canceled.", "Confirm state; escalate billing requests.", "No payment promise"),
        ("Unknown / mismatch", "Signals do not map cleanly.", "Copy support summary and escalate.", "No direct link"),
    ]
    draw_table(c, 46, 478, 700, ["Status", "What it means", "Correct action", "Customer-facing link?"], rows, [145, 195, 245, 115], row_height=53)
    draw_callout(c, "Important distinction", "Email sends do not change payment, billing, agreement, or access status. They only help the buyer resume the allowed next step.", 46, 76, 700, 62, accent=AMBER, fill=AMBER_SOFT)


def page_controls(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 5, "Admin page controls", "ROW REVIEW / RECOVERY ACTIONS", total_pages)
    draw_card(c, "What the page shows", "Buyer and company details, membership and cadence, source path, agreement status, checkout signals, setup state, and email delivery state.", 46, 355, 215, 120, accent=TEAL, title_size=12, body_size=9)
    draw_card(c, "Row actions", "Open Details before acting. Resend agreement, checkout, setup, or welcome email only when the row allows that action. Copy support summary for escalation.", 288, 355, 215, 120, accent=PURPLE, title_size=12, body_size=9)
    draw_card(c, "What it cannot do", "It cannot mark an agreement signed, mark checkout paid, activate billing, edit Stripe subscriptions, delete records, or override member state.", 531, 355, 215, 120, accent=RED, title_size=12, body_size=9)
    draw_callout(c, "Standing rule", "If the row is not clearly complete, describe the current state and next step. Do not promise activation, refund, cancellation, or billing changes without confirmation.", 46, 245, 700, 72, accent=PURPLE, fill=PANEL_SOFT)
    draw_text(c, "SAFE OPERATING LOOP", 46, 190, size=8.5, font="Helvetica-Bold", color=NAVY)
    draw_flow(c, ["Search row", "Open details", "Confirm state", "Use allowed action", "Refresh", "Escalate if mismatched"], 46, 154, 700, active_index=0)
    draw_callout(c, "Avoid this", "Do not use spreadsheets, inbox notes, or memory as the daily source of truth for purchase status.", 46, 80, 700, 54, accent=RED, fill=RED_SOFT)


def page_agreement_checkout(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 6, "Scenario group: agreement and checkout", "SUPPORT PATHS / PAYMENT GATE", total_pages)
    draw_scenario_card(
        c,
        "Agreement pending",
        ["Agreement sent or opened", "Checkout is not paid", "Buyer cannot find signing email"],
        "Confirm buyer email and row state, then use Resend agreement link if available. Ask the buyer to use the newest agreement email.",
        "Do not send checkout instructions before agreement signing.",
        "I resent the agreement email to the buyer address on file. Please use the newest email to review and sign before checkout.",
        46,
        110,
        330,
        360,
        accent=PURPLE,
    )
    draw_scenario_card(
        c,
        "Signed / checkout pending",
        ["Agreement signed time is present", "Payment is unpaid, pending, or failed", "Buyer has not completed payment"],
        "Confirm the signed agreement and unpaid state, then use Resend checkout link if available. Refresh after checkout completes.",
        "Do not tell the buyer the membership is active until payment and setup are complete.",
        "Your agreement appears signed. I resent the secure checkout recovery email so payment can continue from the current signup.",
        416,
        110,
        330,
        360,
        accent=TEAL,
    )


def page_stripe_setup(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 7, "Scenario group: Stripe return and setup", "CHECKOUT REVIEW / ACCOUNT ACCESS", total_pages)
    draw_scenario_card(
        c,
        "Did not return from Stripe",
        ["Buyer says payment completed", "Browser closed or return failed", "Admin row may still be pending"],
        "Refresh the admin row. If completed, guide login or setup. If signals conflict, copy support summary and escalate before asking for another payment step.",
        "Do not ask the buyer to pay again until review confirms it is safe.",
        "We are checking the purchase status before asking you to take another checkout step.",
        46,
        110,
        330,
        360,
        accent=BLUE,
    )
    draw_scenario_card(
        c,
        "Paid but setup pending",
        ["Payment appears complete", "Client/member setup is incomplete", "Buyer cannot access dashboard"],
        "Confirm payment and member setup state. Use Resend setup email when available. Escalate if setup remains stuck after refresh.",
        "Do not share setup tokens or manually mark setup complete.",
        "Payment appears complete, and the remaining step is account setup. I resent the password setup email.",
        416,
        110,
        330,
        360,
        accent=AMBER,
    )


def page_existing_email(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 8, "Scenario group: existing user and email recovery", "LOGIN STATE / EMAIL STATE", total_pages)
    cards = [
        ("Existing user purchase", "Buyer already has an alphaScreen login. Confirm linked member state, then direct them to sign in with the existing account.", "Do not create a duplicate user.", PURPLE),
        ("Welcome email not received", "If setup exists and the row allows it, resend welcome email. Welcome email should not block working dashboard access.", "Do not paste provider payloads into notes.", TEAL),
        ("Setup email not received", "Confirm payment and setup state, then resend setup email if available. Ask the buyer to use the newest setup email.", "Do not share password setup tokens.", BLUE),
    ]
    for index, (title, body, avoid, accent) in enumerate(cards):
        x = 46 + index * 235
        draw_card(c, title, body, x, 315, 205, 150, accent=accent, title_size=12, body_size=9)
        draw_callout(c, "Do not", avoid, x, 230, 205, 58, accent=RED, fill=RED_SOFT)
    draw_text(c, "CUSTOMER WORDING", 46, 178, size=8.5, font="Helvetica-Bold", color=NAVY)
    draw_table(
        c,
        46,
        155,
        700,
        ["Situation", "Use this wording"],
        [
            ("Existing login", "Please sign in with your existing account first. If the new membership is not visible, we will review the account link."),
            ("Welcome email", "I resent the alphaScreen welcome email. You can still sign in if password setup is complete."),
            ("Setup email", "I resent the password setup email. Please use the newest email to finish account access."),
        ],
        [150, 550],
        row_height=42,
    )


def page_identity_duplicates(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 9, "Scenario group: identity and duplicates", "BUYER IDENTITY / DUPLICATE RISK", total_pages)
    draw_scenario_card(
        c,
        "Wrong buyer email",
        ["Agreement or checkout went to wrong address", "Buyer asks for link forwarding", "Purchase may be signed or paid"],
        "If unsigned and unpaid, recommend restarting signup with the correct buyer email unless an approved admin path exists. Escalate signed or paid records.",
        "Do not forward agreement, checkout, or setup links to a different email.",
        "The buyer email controls agreement, checkout, and setup delivery. We need to review the safest correction path.",
        46,
        110,
        330,
        360,
        accent=AMBER,
    )
    draw_scenario_card(
        c,
        "Duplicate purchase attempt",
        ["Multiple rows for same buyer or company", "One row may be more advanced", "A paid duplicate is possible"],
        "Compare status, created time, membership, cadence, and payment indicators. Continue from the most advanced legitimate row and escalate any possible duplicate billing.",
        "Do not delete duplicate records or ask for repeat payment while any row may be paid.",
        "I see more than one signup attempt, so I am checking the active path before sending another payment or setup instruction.",
        416,
        110,
        330,
        360,
        accent=PURPLE,
    )


def page_billing_mismatch(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 10, "Billing requests and payment mismatch", "ESCALATION REQUIRED / NO MANUAL STRIPE MUTATION", total_pages)
    draw_card(c, "Cancellation, refund, or membership change", "Locate the row, copy the support summary, acknowledge the request without promising the outcome, and route it to the approved billing/admin owner.", 46, 335, 330, 130, accent=AMBER, title_size=12, body_size=9.3)
    draw_card(c, "Webhook or payment mismatch", "If buyer-reported payment, Stripe indicators, and setup state do not agree, refresh, copy the support summary, and escalate before asking for another payment step.", 416, 335, 330, 130, accent=BLUE, title_size=12, body_size=9.3)
    draw_callout(c, "Avoid this", "Do not promise a refund, cancellation, membership change, or billing cadence change. Do not edit Stripe subscriptions directly from this workflow.", 46, 230, 700, 72, accent=RED, fill=RED_SOFT)
    draw_callout(c, "Customer wording", "I received your request and will route it for billing review. We will confirm the next step after the purchase and payment status have been reviewed.", 46, 125, 700, 72, accent=PURPLE, fill=PANEL_SOFT)


def page_email_escalation(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 11, "Email delivery issues and escalation rules", "ONE SAFE RESEND / SANITIZED ESCALATION", total_pages)
    draw_card(c, "Email delivery issue", "Confirm the needed email, use the correct resend action once if available, ask the buyer to check spam and quarantine, then wait for delivery state to update.", 46, 360, 330, 105, accent=TEAL, title_size=12, body_size=9)
    draw_card(c, "Escalate immediately", "Payment/state mismatch, signed agreement blocked from checkout, setup stuck after payment, wrong buyer email after signing or payment, possible duplicate billing, or repeated delivery failure.", 416, 360, 330, 105, accent=AMBER, title_size=12, body_size=9)
    draw_text(c, "INCLUDE", 46, 300, size=8.5, font="Helvetica-Bold", color=NAVY)
    draw_bullets(c, ["Sanitized support summary", "Current status label and buyer-reported problem", "Recovery action already attempted and approximate time"], 46, 275, 315, bullet_color=TEAL, size=9, gap=8)
    draw_text(c, "DO NOT INCLUDE", 416, 300, size=8.5, font="Helvetica-Bold", color=NAVY)
    draw_bullets(c, ["Secrets, tokens, auth headers, or webhook signing details", "Full signing, setup, or password reset URLs", "Raw provider payloads or unnecessary private data"], 416, 275, 315, bullet_color=RED, size=9, gap=8)
    draw_callout(c, "Safe wording", "I resent the correct alphaScreen email for your current setup step. If it still does not arrive, we will escalate the delivery check.", 46, 94, 700, 68, accent=PURPLE, fill=PANEL_SOFT)


def page_snippets(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 12, "Safe support language snippets", "CUSTOMER WORDING / NO PROMISES", total_pages)
    rows = [
        ("Agreement link", "I resent the alphaScreen membership agreement to the buyer address on file. Please use the newest email to review and sign before checkout."),
        ("Checkout link", "Your agreement appears to be signed. I resent the secure checkout recovery email so payment can continue from the current signup."),
        ("Password setup", "Payment appears complete, and the remaining step is password setup. I resent the setup email to the buyer address on file."),
        ("Existing account login", "This purchase appears tied to an existing alphaScreen login. Please sign in with your existing account first."),
        ("Payment under review", "I do not want to ask you to repeat checkout until the current payment state is verified. We are reviewing the purchase status."),
        ("Billing request", "I received your request and will route it for billing review. We will confirm the next step after the purchase and payment status have been reviewed."),
        ("Escalation", "This needs internal review before we can safely change the purchase path. I am escalating the current status and will follow up."),
    ]
    draw_table(c, 46, 492, 700, ["Situation", "Use this wording"], rows, [155, 545], row_height=48)


def page_glossary(c: canvas.Canvas, total_pages: int) -> None:
    draw_header(c, 13, "Glossary and production use note", "FINAL STANDARD / LIVE SUPPORT", total_pages)
    glossary = [
        ("Purchase intent", "Internal record created when a buyer starts public membership signup."),
        ("Membership agreement", "Agreement the buyer reviews and signs before secure checkout."),
        ("Stripe Checkout", "Secure payment step used after agreement signing."),
        ("Setup email", "Email that helps the buyer set a password or complete account access."),
        ("Welcome email", "Email welcoming a new alphaScreen client after activation when applicable."),
        ("Support summary", "Sanitized row summary intended for internal escalation."),
    ]
    for index, (term, definition) in enumerate(glossary):
        x = 46 + (index % 2) * 350
        y = 438 - (index // 2) * 82
        draw_card(c, term, definition, x, y, 320, 58, accent=[PURPLE, TEAL, BLUE, AMBER, PURPLE, TEAL][index], title_size=10.5, body_size=8.5)
    draw_callout(
        c,
        "Production use note",
        "After launch, use the production Admin Public Purchases page for live customers. Do not use QA links, QA records, or QA screenshots when supporting a live buyer.",
        46,
        154,
        700,
        68,
        accent=AMBER,
        fill=AMBER_SOFT,
    )
    draw_callout(
        c,
        "Final standard",
        "Each buyer should receive the next safe step for their current purchase state. Admin recovery actions help the buyer resume agreement, checkout, or setup. They do not replace agreement signing, payment confirmation, or account activation.",
        46,
        74,
        700,
        68,
        accent=TEAL,
        fill=MINT_SOFT,
    )


def generate() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT_PATH), pagesize=landscape(letter))
    c.setTitle("alphaScreen Public Purchase Support Playbook")
    c.setAuthor("alphaSource")
    c.setSubject("Admin-only support guide for self-serve alphaScreen membership purchases")
    c.setKeywords("alphaScreen, alphaSource, public purchases, support playbook")

    pages = [
        draw_cover,
        page_support_scope,
        page_lifecycle,
        page_quick_reference,
        page_controls,
        page_agreement_checkout,
        page_stripe_setup,
        page_existing_email,
        page_identity_duplicates,
        page_billing_mismatch,
        page_email_escalation,
        page_snippets,
        page_glossary,
    ]
    total_pages = len(pages)
    for page in pages:
        page(c, total_pages)
        c.showPage()
    c.save()


if __name__ == "__main__":
    generate()
    print(OUTPUT_PATH)
