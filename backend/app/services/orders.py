
ORDERS = {
    "ORD-101": {
        "order_id": "ORD-101",
        "customer": "Priya Sharma",
        "product": "Vitamin C Serum (30ml)",
        "value": 699,
        "status": "Out for Delivery",
        "courier": "BlueDart",
        "tracking_id": "BD-982103",
        "delivery_note": "Expected by 6 PM today",
        "days_since_delivery": None,
    },
    "ORD-102": {
        "order_id": "ORD-102",
        "customer": "Rahul Verma",
        "product": "Hydrating Sunscreen SPF 50",
        "value": 499,
        "status": "Delivered",
        "courier": "Delhivery",
        "tracking_id": "DL-441029",
        "delivery_note": "Delivered 14 days ago",
        "days_since_delivery": 14,
    },
    "ORD-103": {
        "order_id": "ORD-103",
        "customer": "Ananya Patel",
        "product": "Green Tea Face Wash + Toner",
        "value": 850,
        "status": "Processing",
        "courier": None,
        "tracking_id": None,
        "delivery_note": "Ordered 3 hours ago",
        "days_since_delivery": None,
    },
}


def get_order_details(order_id: str) -> dict | None:
    """Return an order record, or None if it does not exist."""
    normalized_id = order_id.strip().upper()
    return ORDERS.get(normalized_id)
