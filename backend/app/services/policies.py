
def check_cancellation(order: dict) -> dict:
    eligible = order["status"].lower() == "processing"

    return {
        "eligible": eligible,
        "message": (
            "This order is eligible for cancellation."
            if eligible
            else (
                "Cancellation is allowed only while an order "
                "is Processing. Once shipped or out for delivery, "
                "it cannot be cancelled."
            )
        ),
    }


def check_return(
    days_since_delivery: int | None,
    unopened: bool,
    unused: bool,
    original_packaging: bool,
) -> dict:
    if days_since_delivery is None:
        return {
            "eligible": False,
            "message": "Delivery date must be verified first.",
        }

    eligible = (
        0 <= days_since_delivery <= 7
        and unopened
        and unused
        and original_packaging
    )

    return {
        "eligible": eligible,
        "message": (
            "The product meets the stated return conditions."
            if eligible
            else (
                "Returns are accepted within 7 days of delivery "
                "for unopened, unused products in original packaging."
            )
        ),
    }


def check_cod(order_value: float) -> dict:
    eligible = 0 <= order_value <= 2500

    return {
        "eligible": eligible,
        "message": (
            "COD is available for this order value."
            if eligible
            else "COD is available only for orders up to ₹2,500."
        ),
    }
