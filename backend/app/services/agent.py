import json
import logging
import os
import re
from app.core.metrics import measure_latency

from dotenv import load_dotenv
from groq import Groq

from app.services.orders import get_order_details
from app.services.policies import check_cancellation, check_cod

load_dotenv()
logger = logging.getLogger(__name__)

API_KEY = os.getenv("GROQ_API_KEY")
MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
if not API_KEY:
    raise RuntimeError("GROQ_API_KEY is missing from backend/.env")
client = Groq(api_key=API_KEY)

SYSTEM_INSTRUCTIONS = """
You are Aria, the friendly customer-support voice agent for Aura Skincare.
Speak warmly and naturally. Keep answers concise and suitable for speech.
Understand Indian English, Hindi, and Hinglish (Hindi-English code-mixing). Reply in the language style the customer used: English for English, and simple natural Hinglish for Hinglish. Preserve product names, order IDs, and tracking IDs exactly.
Use rupees (₹) for prices.

POLICIES:
- Free shipping for orders above ₹499. Orders below ₹499 have a ₹50 shipping fee.
- Delivery typically takes 3–5 business days.
- Returns are allowed within 7 days of delivery only if unopened, unused, and in original packaging.
- Defective products must be reported within 48 hours with photos for a replacement.
- Cancellation is permitted only while an order is Processing.
- Shipped and Out for Delivery orders cannot be cancelled.
- COD is available for orders up to ₹2,500, payable in cash or UPI.

STRICT ORDER RULES:
- If the latest customer message contains an order ID, answer ONLY about that ID.
- Never combine information from different orders unless the customer explicitly asks to compare them.
- History can clarify "it" or "that order", but cannot override an ID in the latest message.
- If the customer says only "order ID" without a number and no clear referent, ask which ID they mean; do not repeat the previous answer.
- If a question is ambiguous, ask one short clarification rather than guessing.
- Distinguish checking an order's existing payment method from checking whether an order value would qualify for COD on a new order.
- For COD eligibility, check the order value against the ₹2,500 limit; do not imply an existing order's payment method can be changed.
- For returns, apply the 7-day window after delivery and the unopened, unused, original-packaging requirements. Defect reports require photos within 48 hours of discovery for replacement.
- Use tools for order details and eligibility. Tool results are authoritative.
- A request to change an order status is not an available operation. Never claim to change status, cancel an order, or issue a refund.
- Cancellation eligibility is not cancellation completion.
- Never invent order details, tracking numbers, or delivery estimates.
- Only help with Aura Skincare customer-support requests.
- Plain text only, no Markdown. Preserve exact order IDs and tracking numbers.
"""

def lookup_order(order_id: str) -> dict:
    normalized_id = order_id.strip().upper()
    order = get_order_details(normalized_id)
    if order is None:
        return {"found": False, "order_id": normalized_id, "message": "No order was found with that ID."}
    return {"found": True, "order": order}


def cancellation_eligibility(order_id: str) -> dict:
    normalized_id = order_id.strip().upper()
    order = get_order_details(normalized_id)
    if order is None:
        return {"found": False, "order_id": normalized_id, "message": "Order not found."}
    return {
        "found": True,
        "order_id": normalized_id,
        "eligibility": check_cancellation(order),
        "order": order,
    }


def cod_eligibility(order_value: float) -> dict:
    if order_value < 0:
        return {"eligible": False, "message": "Order value cannot be negative."}
    return {"order_value": order_value, "eligibility": check_cod(order_value)}


TOOLS = [
    {"type": "function", "function": {
        "name": "lookup_order",
        "description": "Look up a customer's order by its exact order ID.",
        "parameters": {"type": "object", "properties": {
            "order_id": {"type": "string", "description": "Exact ID, e.g. ORD-101"}
        }, "required": ["order_id"], "additionalProperties": False},
    }},
    {"type": "function", "function": {
        "name": "cancellation_eligibility",
        "description": "Check cancellation eligibility. Does not cancel the order.",
        "parameters": {"type": "object", "properties": {
            "order_id": {"type": "string"}
        }, "required": ["order_id"], "additionalProperties": False},
    }},
    {"type": "function", "function": {
        "name": "cod_eligibility",
        "description": "Check COD eligibility for an order value in rupees.",
        "parameters": {"type": "object", "properties": {
            "order_value": {"type": "number"}
        }, "required": ["order_value"], "additionalProperties": False},
    }},
]

AVAILABLE_FUNCTIONS = {
    "lookup_order": lookup_order,
    "cancellation_eligibility": cancellation_eligibility,
    "cod_eligibility": cod_eligibility,
}


def execute_tool(name: str, arguments_json: str) -> str:
    function = AVAILABLE_FUNCTIONS.get(name)
    if function is None:
        return json.dumps({"error": "Unknown tool."})
    try:
        return json.dumps(function(**json.loads(arguments_json)), ensure_ascii=False, default=str)
    except (ValueError, TypeError, KeyError) as exc:
        logger.warning("Invalid tool arguments for %s: %s", name, exc)
        return json.dumps({"error": "Invalid tool arguments."})
    except Exception:
        logger.exception("Tool execution failed: %s", name)
        return json.dumps({"error": "Tool execution failed."})


def clean_customer_response(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"```[a-zA-Z0-9_-]*\s*", "", text).replace("```", "")
    text = re.sub(r"(?m)^\s{0,3}#{1,6}\s+", "", text)
    text = re.sub(r"(?m)^\s*[-*+]\s+", "", text)
    text = re.sub(r"(?m)^\s*\d+[.)]\s+", "", text)
    text = re.sub(r"\*\*(.*?)\*\*", r"\1", text, flags=re.DOTALL)
    text = re.sub(r"__(.*?)__", r"\1", text, flags=re.DOTALL)
    text = re.sub(r"(?<!\w)\*(.*?)\*(?!\w)", r"\1", text, flags=re.DOTALL)
    text = re.sub(r"(?<!\w)_(.*?)_(?!\w)", r"\1", text, flags=re.DOTALL)
    text = re.sub(r"~~(.*?)~~", r"\1", text, flags=re.DOTALL)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


ORDER_ID_RE = re.compile(r"\bORD[\s-]*(\d{3})\b", re.IGNORECASE)
ORDER_QUERY_RE = re.compile(r"\b(order|tracking|track|delivery|delivered|shipment|shipped|status|cancel|cancellation)\b", re.I)
CHANGE_STATUS_RE = re.compile(r"\b(change|update|set|mark|modify)\b.*\b(status|state)\b|\b(status|state)\b.*\b(change|update|set|mark|modify)\b", re.I)
CANCEL_RE = re.compile(r"\b(cancel|cancellation|cancelled|canceled)\b", re.I)
RETURN_RE = re.compile(r"\b(return|refund|send back)\b", re.I)
COD_RE = re.compile(r"\b(cash on delivery|cod|cash|upi|cash at delivery)\b", re.I)
CANCEL_RE = re.compile(r"\b(cancel|cancellation|cancelled|canceled)\b", re.I)


def _format_order_status(order: dict) -> str:
    order_id = str(order.get("order_id", "this order"))
    reply = f"Your order {order_id} is currently {order.get('status', 'unavailable')}."
    if order.get("product"):
        reply += f" The product is {order['product']}."
    if order.get("courier") and order.get("tracking_id"):
        reply += f" The courier is {order['courier']}, with tracking ID {order['tracking_id']}."
    if order.get("delivery_note"):
        reply += f" {str(order['delivery_note']).strip()}"
    return reply


def _explicit_order_answer(message: str, order_id: str) -> str:
    order = get_order_details(order_id)
    if order is None:
        return f"I couldn't find an order with ID {order_id}. Could you verify the ID?"

    if CHANGE_STATUS_RE.search(message):
        return (
            f"I can check order {order_id}, but I can't change its status in this demo. "
            f"Its current status is {order.get('status', 'unavailable')}."
        )

    if CANCEL_RE.search(message):
        result = check_cancellation(order)
        eligible = None
        if isinstance(result, dict):
            eligible = result.get("eligible", result.get("is_eligible"))
        if eligible is None:
            eligible = str(order.get("status", "")).lower() == "processing"
        if eligible:
            return (
                f"Order {order_id} is currently Processing and is eligible for cancellation. "
                "I haven't cancelled it. Would you like me to explain the next steps?"
            )
        return (
            f"Order {order_id} is currently {order.get('status', 'unavailable')}, "
            "so it isn't eligible for cancellation under our policy."
        )

    return _format_order_status(order)



def _return_eligibility_answer(order_id: str) -> str:
    """Answer return questions using the order record and the return policy."""
    order = get_order_details(order_id)
    if order is None:
        return f"I couldn't find an order with ID {order_id}. Could you verify the ID?"

    status = str(order.get("status", "")).strip().lower()
    delivery_note = str(order.get("delivery_note", ""))

    if status != "delivered":
        return (
            f"You can't start a return for order {order_id} yet because it is currently "
            f"{order.get('status', 'not delivered')}. Our return window begins after delivery. "
            "Once it is delivered, returns are accepted within 7 days if the product is unopened, "
            "unused, and in its original packaging."
        )

    days_match = re.search(r"delivered\s+(\d+)\s+days?\s+ago", delivery_note, re.IGNORECASE)
    if days_match and int(days_match.group(1)) > 7:
        return (
            f"Unfortunately, order {order_id} was delivered {days_match.group(1)} days ago, "
            "so it is outside our 7-day return window. If the product is defective, report it "
            "within 48 hours of discovering the issue and provide photos for a replacement."
        )

    if days_match:
        return (
            f"Order {order_id} appears to be within the 7-day return window. A return is subject "
            "to the product being unopened, unused, and in its original packaging."
        )

    return (
        f"Order {order_id} is marked Delivered, but I don't have a delivery date to verify whether "
        "it is within the 7-day return window. Returns must be unopened, unused, and in original packaging."
    )


def _resolve_order_id(message: str, history: list[dict] | None) -> str | None:
    match = ORDER_ID_RE.search(message or "")
    if match:
        return f"ORD-{match.group(1)}"
    # Only use prior customer turns for a clear follow-up (it/that order).
    if re.search(r"\b(it|that order|this order|the order)\b", message, re.I):
        for item in reversed(history or []):
            if item.get("role") == "user":
                prior = ORDER_ID_RE.search(str(item.get("text", "")))
                if prior:
                    return f"ORD-{prior.group(1)}"
    return None


def _cancellation_answer(order_id: str) -> str:
    order = get_order_details(order_id)
    if order is None:
        return f"I couldn't find an order with ID {order_id}. Could you verify the ID?"
    result = check_cancellation(order)
    status = str(order.get("status", "unknown"))
    eligible = None
    reason = ""
    if isinstance(result, dict):
        eligible = result.get("eligible", result.get("is_eligible"))
        reason = str(result.get("message") or result.get("reason") or "")
    if eligible is None:
        eligible = status.strip().lower() == "processing"
    if eligible:
        return f"Order {order_id} is currently {status} and is eligible for cancellation. I haven't cancelled it."
    return f"Order {order_id} is currently {status}, so it isn't eligible for cancellation. {reason}".strip()


def _cod_answer(order_id: str) -> str:
    order = get_order_details(order_id)
    if order is None:
        return f"I couldn't find an order with ID {order_id}. Could you verify the ID?"
    try:
        value = float(order.get("value", order.get("order_value", 0)))
    except (TypeError, ValueError):
        return f"I found {order_id}, but its order value isn't available to check COD eligibility."
    result = check_cod(value)
    eligible = None
    reason = ""
    if isinstance(result, dict):
        eligible = result.get("eligible", result.get("is_eligible"))
        reason = str(result.get("message") or result.get("reason") or "")
    if eligible is None:
        eligible = value <= 2500
    if eligible:
        return (
            f"Order {order_id} has a value of ₹{value:g}, which is within our ₹2,500 cash-on-delivery eligibility limit. "
            "For eligible orders, COD can be paid in cash or UPI at the doorstep. This check does not change the payment method on an order that has already been placed."
        )
    return f"Order {order_id} is not eligible for cash on delivery. {reason}".strip()


def _policy_answer_for_order(message: str, order_id: str) -> str | None:
    if CHANGE_STATUS_RE.search(message):
        order = get_order_details(order_id)
        if order is None:
            return f"I couldn't find an order with ID {order_id}. Could you verify the ID?"
        return f"I can check order {order_id}, but I can't change its status in this demo. Its current status is {order.get('status', 'unavailable')}."
    if RETURN_RE.search(message):
        return _return_eligibility_answer(order_id)
    if CANCEL_RE.search(message):
        return _cancellation_answer(order_id)
    if COD_RE.search(message):
        return _cod_answer(order_id)
    if ORDER_QUERY_RE.search(message):
        order = get_order_details(order_id)
        if order is None:
            return f"I couldn't find an order with ID {order_id}. Could you verify the ID?"
        return _format_order_status(order)
    return None

def ask_aria(message: str, history: list[dict] | None = None, language_code: str = "en-IN") -> dict:
    message = message.strip()
    use_hindi = str(language_code).strip().lower() == "hi-in"
    if not message:
        return {"reply": "Sorry, I didn't catch that. Could you repeat it?"}

    # Deterministic English replies are used only in English mode. In Hindi mode,
    # route through the model so the response itself is Hindi, not English text
    # spoken with a Hindi voice.
    order_id = _resolve_order_id(message, history)
    if not use_hindi:
        if order_id:
            policy_reply = _policy_answer_for_order(message, order_id)
            if policy_reply is not None:
                return {"reply": clean_customer_response(policy_reply)}

        if RETURN_RE.search(message) or CANCEL_RE.search(message) or COD_RE.search(message):
            if not order_id:
                return {"reply": "I can check that policy for you. Which order ID are you asking about?"}

        if re.fullmatch(r"(the\\s+)?order\\s+id[.!?, ]*", message, re.I):
            return {"reply": "Sure. Which order ID would you like me to check?"}

    system_instructions = SYSTEM_INSTRUCTIONS
    if use_hindi:
        system_instructions += """

LANGUAGE OVERRIDE — IMPORTANT:
- Respond entirely in natural, conversational Hindi written in Devanagari script.
- Do not respond in English and do not merely write English sentences with Hindi number words.
- Translate ordinary phrases such as "Your order is currently delivered" into natural Hindi.
- Keep order IDs (ORD-101), tracking IDs, brand names, and product names exactly as written.
- Prices and dates may be expressed naturally in Hindi.
- Use tools as usual and explain policy results in Hindi.
- Example style: "आपका ऑर्डर ORD-102 डिलीवर हो चुका है। इसे 14 दिन पहले डिलीवर किया गया था, इसलिए यह 7 दिन की रिटर्न अवधि से बाहर है।"
"""
    messages = [{"role": "system", "content": system_instructions}]
    for item in (history or [])[-8:]:
        role, content = item.get("role"), item.get("text", "")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            messages.append({"role": role, "content": content[:2000]})
    messages.append({"role": "user", "content": message[:3000]})

    try:
        for _ in range(5):
            with measure_latency("groq_completion"):
                response = client.chat.completions.create(
                    model=MODEL,
                    messages=messages,
                    tools=TOOLS,
                    tool_choice="auto",
                    temperature=0.1,
                    max_completion_tokens=500,
                )
            assistant_message = response.choices[0].message
            messages.append(assistant_message.model_dump(exclude_none=True))
            tool_calls = assistant_message.tool_calls or []
            if not tool_calls:
                reply = clean_customer_response(assistant_message.content or "")
                return {"reply": reply or "I'm sorry, I couldn't form a clear response. Could you rephrase that?"}

            for call in tool_calls:
                with measure_latency(f"tool_{call.function.name}"):
                    result = execute_tool(
                        call.function.name,
                        call.function.arguments or "{}",
                    )
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": result,
                })

        return {"reply": "I couldn't complete that check just now. Please try again."}
    except Exception:
        logger.exception("Groq support request failed")
        return {"reply": "I'm having trouble accessing support information right now. Please try again in a moment."}
