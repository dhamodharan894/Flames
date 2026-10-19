"""
Find Your Flame - FLAMES Love Calculator
A romantic web application using Flask and the classic FLAMES algorithm
"""

from flask import Flask, render_template, request, jsonify

app = Flask(__name__)


def calculate_flames(name1, name2):
    """
    Implements the FLAMES algorithm to calculate relationship compatibility
    
    FLAMES stands for:
    F - Friends
    L - Lovers
    A - Affection
    M - Marriage
    E - Enemies
    S - Siblings
    
    Algorithm:
    1. Remove common letters from both names
    2. Count remaining letters
    3. Use count to eliminate letters from FLAMES
    4. The remaining letter is the result
    """
    
    # Convert names to lowercase and remove spaces
    name1 = name1.lower().replace(" ", "")
    name2 = name2.lower().replace(" ", "")
    
    # Convert names to lists for easier manipulation
    name1_list = list(name1)
    name2_list = list(name2)
    
    # Remove common letters
    for char in name1[:]:  # Iterate over a copy
        if char in name2_list:
            name1_list.remove(char)
            name2_list.remove(char)
    
    # Count remaining letters
    remaining_count = len(name1_list) + len(name2_list)
    
    # FLAMES string
    flames = "FLAMES"
    flames_list = list(flames)
    
    # Elimination process
    index = 0
    while len(flames_list) > 1:
        # Calculate index to remove
        index = (index + remaining_count - 1) % len(flames_list)
        flames_list.pop(index)
        # Adjust index after removal
        if index == len(flames_list) and flames_list:
            index = 0
    
    # Get the final result
    result_char = flames_list[0]
    
    # Map result to full words with messages
    result_map = {
        'F': {
            'result': 'Friends',
            'message': 'You both share a beautiful friendship bond! 🤝'
        },
        'L': {
            'result': 'Lovers',
            'message': 'You both are meant to be together ❤️'
        },
        'A': {
            'result': 'Affection',
            'message': 'There is deep affection and care between you! 💕'
        },
        'M': {
            'result': 'Marriage',
            'message': 'Wedding bells are ringing! You are perfect for each other! 💍'
        },
        'E': {
            'result': 'Enemies',
            'message': 'Opposites attract, but you might clash sometimes! ⚡'
        },
        'S': {
            'result': 'Siblings',
            'message': 'You share a sibling-like bond! Family vibes! 👫'
        }
    }
    
    return result_map[result_char]


@app.route('/')
def index():
    """Render the homepage"""
    return render_template('index.html')


@app.route('/flames', methods=['POST'])
def flames():
    """
    Handle FLAMES calculation requests
    Accepts JSON with name1 and name2
    Returns JSON with result and message
    """
    try:
        data = request.get_json()
        name1 = data.get('name1', '').strip()
        name2 = data.get('name2', '').strip()
        
        # Validate inputs
        if not name1 or not name2:
            return jsonify({
                'error': 'Please enter both names!'
            }), 400
        
        if len(name1) < 2 or len(name2) < 2:
            return jsonify({
                'error': 'Names must be at least 2 characters long!'
            }), 400
        
        # Calculate FLAMES result
        result = calculate_flames(name1, name2)
        
        return jsonify(result)
    
    except Exception as e:
        return jsonify({
            'error': 'Something went wrong. Please try again!'
        }), 500


if __name__ == '__main__':
    # Run the Flask app
    app.run(debug=True, host='0.0.0.0', port=5000)
