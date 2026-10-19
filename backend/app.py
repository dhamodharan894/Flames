"""
Find Your Flame API
Flask backend for the FLAMES love calculator.
"""

from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})


def calculate_flames(name1, name2):
    """
    Implements the FLAMES algorithm to calculate relationship compatibility.
    """
    name1 = name1.lower().replace(" ", "")
    name2 = name2.lower().replace(" ", "")

    name1_list = list(name1)
    name2_list = list(name2)

    for char in name1[:]:
        if char in name2_list:
            name1_list.remove(char)
            name2_list.remove(char)

    remaining_count = len(name1_list) + len(name2_list)
    flames = "FLAMES"
    flames_list = list(flames)

    index = 0
    while len(flames_list) > 1:
        index = (index + remaining_count - 1) % len(flames_list)
        flames_list.pop(index)
        if index == len(flames_list) and flames_list:
            index = 0

    result_char = flames_list[0]
    result_map = {
        "F": {
            "result": "Friends",
            "message": "You both share a beautiful friendship bond! 🤝"
        },
        "L": {
            "result": "Lovers",
            "message": "You both are meant to be together ❤️"
        },
        "A": {
            "result": "Affection",
            "message": "There is deep affection and care between you! 💕"
        },
        "M": {
            "result": "Marriage",
            "message": "Wedding bells are ringing! You are perfect for each other! 💍"
        },
        "E": {
            "result": "Enemies",
            "message": "Opposites attract, but you might clash sometimes! ⚡"
        },
        "S": {
            "result": "Siblings",
            "message": "You share a sibling-like bond! Family vibes! 👫"
        }
    }

    return result_map[result_char]


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/flames", methods=["POST"])
def flames_api():
    try:
        data = request.get_json(silent=True) or {}
        name1 = str(data.get("name1", "")).strip()
        name2 = str(data.get("name2", "")).strip()

        if not name1 or not name2:
            return jsonify({"error": "Please enter both names!"}), 400

        if len(name1) < 2 or len(name2) < 2:
            return jsonify({"error": "Names must be at least 2 characters long!"}), 400

        result = calculate_flames(name1, name2)
        return jsonify(result)

    except Exception:
        return jsonify({"error": "Something went wrong. Please try again!"}), 500


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
