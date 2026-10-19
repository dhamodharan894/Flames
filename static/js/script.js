/**
 * Find Your Flame - JavaScript
 * Handles form submission, API calls, and dynamic UI updates
 */

// Romantic quotes for the quotes section
const romanticQuotes = [
    {
        text: "Love is not about how many days, months, or years you have been together. Love is about how much you love each other every single day.",
        author: "Anonymous"
    },
    {
        text: "The best thing to hold onto in life is each other.",
        author: "Audrey Hepburn"
    },
    {
        text: "I love you not only for what you are, but for what I am when I am with you.",
        author: "Roy Croft"
    },
    {
        text: "You know you're in love when you can't fall asleep because reality is finally better than your dreams.",
        author: "Dr. Seuss"
    },
    {
        text: "Love is composed of a single soul inhabiting two bodies.",
        author: "Aristotle"
    },
    {
        text: "In all the world, there is no heart for me like yours. In all the world, there is no love for you like mine.",
        author: "Maya Angelou"
    }
];

// DOM Elements
const flamesForm = document.getElementById('flamesForm');
const name1Input = document.getElementById('name1');
const name2Input = document.getElementById('name2');
const loadingDiv = document.getElementById('loading');
const resultDiv = document.getElementById('result');
const resultText = document.getElementById('resultText');
const resultMessage = document.getElementById('resultMessage');
const errorDiv = document.getElementById('error');
const tryAgainButton = document.getElementById('tryAgain');
const quoteText = document.getElementById('quote');
const quoteAuthor = document.querySelector('.quote-author');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Start quote rotation
    rotateQuotes();
    
    // Smooth scroll for hero button
    const glowButton = document.querySelector('.glow-button');
    if (glowButton) {
        glowButton.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('calculator').scrollIntoView({
                behavior: 'smooth'
            });
        });
    }
});

// Handle form submission
flamesForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    // Get input values
    const name1 = name1Input.value.trim();
    const name2 = name2Input.value.trim();
    
    // Validate inputs
    if (!name1 || !name2) {
        showError('Please enter both names!');
        return;
    }
    
    if (name1.length < 2 || name2.length < 2) {
        showError('Names must be at least 2 characters long!');
        return;
    }
    
    // Hide any previous results or errors
    hideAll();
    
    // Show loading animation
    loadingDiv.classList.remove('hidden');
    
    try {
        // Send POST request to Flask backend
        const response = await fetch('/flames', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name1: name1,
                name2: name2
            })
        });
        
        const data = await response.json();
        
        // Hide loading
        loadingDiv.classList.add('hidden');
        
        // Check for errors
        if (!response.ok || data.error) {
            showError(data.error || 'Something went wrong!');
            return;
        }
        
        // Display result
        displayResult(data.result, data.message);
        
    } catch (error) {
        // Hide loading
        loadingDiv.classList.add('hidden');
        
        // Show error message
        showError('Failed to connect to server. Please try again!');
        console.error('Error:', error);
    }
});

// Display FLAMES result
function displayResult(result, message) {
    resultText.textContent = result;
    resultMessage.textContent = message;
    
    // Add special effects for Marriage and Lovers
    if (result === 'Marriage' || result === 'Lovers') {
        resultDiv.classList.add('special-result');
        createConfetti();
    }
    
    // Show result container
    resultDiv.classList.remove('hidden');
    
    // Scroll to result
    resultDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Show error message
function showError(message) {
    errorDiv.textContent = message;
    errorDiv.classList.remove('hidden');
    
    // Auto-hide error after 5 seconds
    setTimeout(() => {
        errorDiv.classList.add('hidden');
    }, 5000);
}

// Hide all result/error/loading divs
function hideAll() {
    loadingDiv.classList.add('hidden');
    resultDiv.classList.add('hidden');
    errorDiv.classList.add('hidden');
    resultDiv.classList.remove('special-result');
}

// Try Again button handler
tryAgainButton.addEventListener('click', () => {
    hideAll();
    name1Input.value = '';
    name2Input.value = '';
    name1Input.focus();
    
    // Scroll back to form
    flamesForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// Create confetti effect for special results
function createConfetti() {
    const colors = ['#ff6b6b', '#f093fb', '#feca57', '#48dbfb', '#ff9ff3'];
    const confettiCount = 50;
    
    for (let i = 0; i < confettiCount; i++) {
        setTimeout(() => {
            const confetti = document.createElement('div');
            confetti.style.position = 'fixed';
            confetti.style.left = Math.random() * 100 + '%';
            confetti.style.top = '-10px';
            confetti.style.width = '10px';
            confetti.style.height = '10px';
            confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            confetti.style.borderRadius = '50%';
            confetti.style.pointerEvents = 'none';
            confetti.style.zIndex = '9999';
            confetti.style.animation = `confettiFall ${2 + Math.random() * 2}s linear forwards`;
            
            document.body.appendChild(confetti);
            
            // Remove confetti after animation
            setTimeout(() => {
                confetti.remove();
            }, 4000);
        }, i * 50);
    }
}

// Add confetti animation dynamically
const style = document.createElement('style');
style.textContent = `
    @keyframes confettiFall {
        to {
            transform: translateY(100vh) rotate(360deg);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

// Rotate quotes every 8 seconds
function rotateQuotes() {
    let currentIndex = 0;
    
    setInterval(() => {
        currentIndex = (currentIndex + 1) % romanticQuotes.length;
        const quote = romanticQuotes[currentIndex];
        
        // Fade out
        quoteText.style.opacity = '0';
        quoteAuthor.style.opacity = '0';
        
        // Change text after fade out
        setTimeout(() => {
            quoteText.textContent = `"${quote.text}"`;
            quoteAuthor.textContent = `- ${quote.author}`;
            
            // Fade in
            quoteText.style.opacity = '1';
            quoteAuthor.style.opacity = '1';
        }, 500);
        
    }, 8000);
}

// Add transition styles for quote rotation
quoteText.style.transition = 'opacity 0.5s ease';
quoteAuthor.style.transition = 'opacity 0.5s ease';

// Add input validation on keyup
name1Input.addEventListener('input', () => {
    name1Input.value = name1Input.value.replace(/[^a-zA-Z\s]/g, '');
});

name2Input.addEventListener('input', () => {
    name2Input.value = name2Input.value.replace(/[^a-zA-Z\s]/g, '');
});

// Easter egg: Shake form on multiple empty submissions
let emptySubmitCount = 0;
flamesForm.addEventListener('submit', (e) => {
    if (!name1Input.value.trim() || !name2Input.value.trim()) {
        emptySubmitCount++;
        if (emptySubmitCount >= 3) {
            const calculatorCard = document.querySelector('.calculator-card');
            calculatorCard.style.animation = 'shake 0.5s';
            setTimeout(() => {
                calculatorCard.style.animation = '';
            }, 500);
            emptySubmitCount = 0;
        }
    } else {
        emptySubmitCount = 0;
    }
});

// Add shake animation
const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
    @keyframes shake {
        0%, 100% { transform: translateX(0); }
        10%, 30%, 50%, 70%, 90% { transform: translateX(-10px); }
        20%, 40%, 60%, 80% { transform: translateX(10px); }
    }
`;
document.head.appendChild(shakeStyle);

console.log('🔥 Find Your Flame loaded successfully! Made with ❤️');
