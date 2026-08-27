"""Tools for Friday, the Order-to-Cash owner's voice assistant.

Friday does not talk to customers and does not touch Postgres directly. It
calls the same Express server the dashboard reads from, through the small
JSON API in ../src/routes/api.js. That keeps one source of truth for orders
and invoices in one language (Node/Postgres), instead of a second client
poking the database on its own.
"""

import logging
import os

import requests
from livekit.agents import RunContext, function_tool

API_BASE_URL = os.getenv("ORDER_TO_CASH_API_URL", "http://localhost:3000").rstrip("/")
API_KEY = os.getenv("VOICE_AGENT_API_KEY")
_HEADERS = {"x-api-key": API_KEY} if API_KEY else {}
_TIMEOUT = 10


def _get(path: str):
    return requests.get(f"{API_BASE_URL}{path}", headers=_HEADERS, timeout=_TIMEOUT)


def _post(path: str):
    return requests.post(f"{API_BASE_URL}{path}", headers=_HEADERS, timeout=_TIMEOUT)


def _get_params(path: str, params: dict):
    return requests.get(f"{API_BASE_URL}{path}", headers=_HEADERS, params=params, timeout=_TIMEOUT)


@function_tool()
async def list_overdue_invoices(context: RunContext) -> str:  # type: ignore
    """
    List every invoice that is currently overdue, with the customer, the
    amount, and how many reminders have already gone out.
    """
    try:
        r = _get("/api/invoices/overdue")
        r.raise_for_status()
        data = r.json()
        rows = data.get("invoices", [])
        if not rows:
            return "No overdue invoices right now."
        currency = data.get("currency", "KES")
        lines = [
            f"INV-{i['id']}: {i.get('name') or i.get('phone')}, "
            f"{currency} {i['amount']}, {i['reminders_sent']} reminder(s) sent"
            for i in rows
        ]
        return "; ".join(lines)
    except Exception as e:
        logging.error(f"list_overdue_invoices failed: {e}")
        return "Could not reach the order-to-cash system to check overdue invoices."


@function_tool()
async def list_unpaid_invoices(context: RunContext) -> str:  # type: ignore
    """
    List every invoice that has not been paid yet, whether or not it is
    overdue. Broader than the overdue list, use this when Boss asks who
    still owes money in general, not just who is late.
    """
    try:
        r = _get("/api/invoices/unpaid")
        r.raise_for_status()
        data = r.json()
        rows = data.get("invoices", [])
        if not rows:
            return "Every invoice is paid."
        currency = data.get("currency", "KES")
        lines = [
            f"INV-{i['id']}: {i.get('name') or i.get('phone')}, "
            f"{currency} {i['amount']}, status {i['status']}"
            for i in rows
        ]
        return "; ".join(lines)
    except Exception as e:
        logging.error(f"list_unpaid_invoices failed: {e}")
        return "Could not reach the order-to-cash system to check unpaid invoices."


@function_tool()
async def list_unattended_orders(context: RunContext) -> str:  # type: ignore
    """
    List orders that still need the owner's attention because an item on
    them never matched the product catalog, so they priced at zero and
    cannot be invoiced properly yet.
    """
    try:
        r = _get("/api/orders/unattended")
        r.raise_for_status()
        data = r.json()
        rows = data.get("orders", [])
        if not rows:
            return "No orders are waiting on pricing right now."
        lines = [
            f"Order {o['id']} from {o.get('name') or o.get('phone')}: "
            + ", ".join(f"{it['qty']} x {it['name']}" for it in o.get("items", []))
            for o in rows
        ]
        return "; ".join(lines)
    except Exception as e:
        logging.error(f"list_unattended_orders failed: {e}")
        return "Could not reach the order-to-cash system to check unattended orders."


@function_tool()
async def list_orders(
    context: RunContext,  # type: ignore
    status: str = "all",
) -> str:
    """
    List recent orders. Pass status="fulfilled" for orders already completed,
    status="unfulfilled" for orders not yet done, or status="all" (the
    default) for both. This is about whether the physical order is done, not
    whether it has been paid.
    """
    try:
        r = _get_params("/api/orders", {"status": status})
        r.raise_for_status()
        data = r.json()
        rows = data.get("orders", [])
        if not rows:
            return f"No {status} orders right now." if status != "all" else "No orders yet."
        currency = data.get("currency", "KES")
        lines = [
            f"Order {o['id']} ({o['status']}) from {o.get('name') or o.get('phone')}: "
            f"{currency} {o['total_amount']}"
            for o in rows
        ]
        return "; ".join(lines)
    except Exception as e:
        logging.error(f"list_orders failed: {e}")
        return "Could not reach the order-to-cash system to list orders."


@function_tool()
async def get_order_summary(context: RunContext) -> str:  # type: ignore
    """
    Give a quick spoken breakdown of orders by kind: how many total, how many
    fulfilled, how many not yet fulfilled, and of those, how many are also
    still waiting on pricing. Use this when Boss asks what kinds of orders
    there are, not for payment status (use get_business_summary for that).
    """
    try:
        r = _get("/api/orders/summary")
        r.raise_for_status()
        s = r.json().get("orders", {})
        return (
            f"{s.get('total', 0)} order(s) total: {s.get('fulfilled', 0)} fulfilled, "
            f"{s.get('unfulfilled', 0)} not yet fulfilled, of which "
            f"{s.get('unfulfilled_needs_pricing', 0)} still need pricing."
        )
    except Exception as e:
        logging.error(f"get_order_summary failed: {e}")
        return "Could not reach the order-to-cash system for an order breakdown."


@function_tool()
async def mark_order_fulfilled(
    context: RunContext,  # type: ignore
    order_id: int,
) -> str:
    """
    Mark one order as fulfilled, meaning the physical order is done and
    delivered. Only call this when Boss clearly says the order is finished;
    never guess. This does not touch payment status, those are separate.
    """
    try:
        r = _post(f"/api/orders/{order_id}/fulfill")
        if r.status_code == 404:
            return f"There is no order {order_id}."
        if r.status_code == 409:
            return f"Order {order_id} was already marked fulfilled."
        r.raise_for_status()
        return f"Order {order_id} is now marked fulfilled."
    except Exception as e:
        logging.error(f"mark_order_fulfilled failed for {order_id}: {e}")
        return f"Could not mark order {order_id} fulfilled right now."


@function_tool()
async def send_mpesa_prompt_for_order(
    context: RunContext,  # type: ignore
    order_id: int,
) -> str:
    """
    Put a real M-Pesa payment prompt (STK push) on the phone of the customer
    behind one order, for that order's invoiced amount. Use this when Boss
    names an order number rather than an invoice number; order numbers and
    invoice numbers are different sequences. Refused if the order is already
    fulfilled, already paid, or not yet priced.
    """
    try:
        r = _post(f"/api/orders/{order_id}/stkpush")
        if r.status_code == 404:
            return f"There is no order {order_id}."
        if r.status_code == 409:
            data = r.json()
            return f"Cannot push order {order_id}: {data.get('error', 'not eligible')}."
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            return f"The M-Pesa prompt for order {order_id} did not go through."
        return f"M-Pesa prompt sent for order {order_id} to {data.get('sentTo', 'the customer')}."
    except Exception as e:
        logging.error(f"send_mpesa_prompt_for_order failed for {order_id}: {e}")
        return f"That M-Pesa prompt did not go through for order {order_id}."


@function_tool()
async def get_invoice_status(
    context: RunContext,  # type: ignore
    invoice_id: int,
) -> str:
    """
    Look up a single invoice by its number and report its amount, status,
    due date, and how many reminders have already gone out.
    """
    try:
        r = _get(f"/api/invoices/{invoice_id}")
        if r.status_code == 404:
            return f"There is no invoice INV-{invoice_id}."
        r.raise_for_status()
        data = r.json()
        i = data["invoice"]
        currency = data.get("currency", "KES")
        return (
            f"INV-{i['id']} for {i.get('name') or i.get('phone')}: "
            f"{currency} {i['amount']}, status {i['status']}, "
            f"due {i['due_date']}, {i['reminders_sent']} reminder(s) sent."
        )
    except Exception as e:
        logging.error(f"get_invoice_status failed for {invoice_id}: {e}")
        return f"Could not check invoice INV-{invoice_id} right now."


@function_tool()
async def send_payment_reminder(
    context: RunContext,  # type: ignore
    invoice_id: int,
) -> str:
    """
    Send an immediate SMS payment reminder for one invoice, outside the
    normal collections schedule. This sends a real message to the customer.
    """
    try:
        r = _post(f"/api/invoices/{invoice_id}/remind")
        if r.status_code == 404:
            return f"There is no invoice INV-{invoice_id}."
        if r.status_code == 409:
            return f"INV-{invoice_id} is already paid, no reminder needed."
        r.raise_for_status()
        data = r.json()
        return f"Reminder sent for INV-{invoice_id} to {data.get('sentTo', 'the customer')}."
    except Exception as e:
        logging.error(f"send_payment_reminder failed for {invoice_id}: {e}")
        return f"That reminder did not go through for INV-{invoice_id}."


@function_tool()
async def send_mpesa_prompt(
    context: RunContext,  # type: ignore
    invoice_id: int,
) -> str:
    """
    Put a real M-Pesa payment prompt (STK push) on the customer's phone for
    one invoice's exact amount, so they can enter their PIN and pay on the
    spot. Only do this when Boss names a specific invoice or customer; this
    is a real charge prompt, not a reminder.
    """
    try:
        r = _post(f"/api/invoices/{invoice_id}/stkpush")
        if r.status_code == 404:
            return f"There is no invoice INV-{invoice_id}."
        if r.status_code == 409:
            data = r.json()
            return f"Cannot push INV-{invoice_id}: {data.get('error', 'not eligible')}."
        r.raise_for_status()
        data = r.json()
        if not data.get("ok"):
            return f"The M-Pesa prompt for INV-{invoice_id} did not go through."
        return f"M-Pesa prompt sent for INV-{invoice_id} to {data.get('sentTo', 'the customer')}."
    except Exception as e:
        logging.error(f"send_mpesa_prompt failed for {invoice_id}: {e}")
        return f"That M-Pesa prompt did not go through for INV-{invoice_id}."


@function_tool()
async def get_order_status(
    context: RunContext,  # type: ignore
    order_id: int,
) -> str:
    """
    Look up a single order by its number and report the customer, items,
    total, and whether it has been fulfilled.
    """
    try:
        r = _get(f"/api/orders/{order_id}")
        if r.status_code == 404:
            return f"There is no order {order_id}."
        r.raise_for_status()
        data = r.json()
        o = data["order"]
        currency = data.get("currency", "KES")
        return (
            f"Order {o['id']} for {o.get('name') or o.get('phone')}: "
            f"{currency} {o['total_amount']} total, source {o['source']}, "
            f"{'fulfilled' if o['status'] == 'fulfilled' else 'not yet fulfilled'}."
        )
    except Exception as e:
        logging.error(f"get_order_status failed for {order_id}: {e}")
        return f"Could not check order {order_id} right now."


@function_tool()
async def get_business_summary(context: RunContext) -> str:  # type: ignore
    """
    Give a quick spoken summary of the business: how many invoices are
    still open, how many are overdue, and how much is outstanding.
    """
    try:
        r = _get("/api/summary")
        r.raise_for_status()
        d = r.json()
        currency = d.get("currency", "KES")
        return (
            f"{d['open_invoices']} invoice(s) still open, "
            f"{d['overdue_invoices']} overdue, "
            f"{currency} {d['outstanding_amount']} outstanding, "
            f"{currency} {d['paid_last_7_days']} paid in the last seven days."
        )
    except Exception as e:
        logging.error(f"get_business_summary failed: {e}")
        return "Could not reach the order-to-cash system for a summary."
