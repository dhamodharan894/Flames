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

const API_URL = 'http://localhost:5000/api/flames';

document.addEventListener('DOMContentLoaded', () => {
  rotateQuotes();

  const glowButton = document.querySelector('.glow-button');
  if (glowButton) {
    glowButton.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('calculator').scrollIntoView({ behavior: 'smooth' });
    });
  }
});

flamesForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const name1 = name1Input.value.trim();
  const name2 = name2Input.value.trim();

  if (!name1 || !name2) {
    showError('Please enter both names!');
    return;
  }

  if (name1.length < 2 || name2.length < 2) {
    showError('Names must be at least 2 characters long!');
    return;
  }

  hideAll();
  loadingDiv.classList.remove('hidden');

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name1, name2 })
    });

    const data = await response.json();
    loadingDiv.classList.add('hidden');

    if (!response.ok || data.error) {
      showError(data.error || 'Something went wrong!');
      return;
    }

    displayResult(data.result, data.message);
  } catch (error) {
    loadingDiv.classList.add('hidden');
    showError('Failed to connect to server. Please try again!');
    console.error('Error:', error);
  }
});

function displayResult(result, message) {
  resultText.textContent = result;
  resultMessage.textContent = message;

  if (result === 'Marriage' || result === 'Lovers') {
    resultDiv.classList.add('special-result');
    createConfetti();
  }

  resultDiv.classList.remove('hidden');
  resultDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function showError(message) {
  errorDiv.textContent = message;
  errorDiv.classList.remove('hidden');

  setTimeout(() => {
    errorDiv.classList.add('hidden');
  }, 5000);
}

function hideAll() {
  loadingDiv.classList.add('hidden');
  resultDiv.classList.add('hidden');
  errorDiv.classList.add('hidden');
  resultDiv.classList.remove('special-result');
}

tryAgainButton.addEventListener('click', () => {
  hideAll();
  name1Input.value = '';
  name2Input.value = '';
  name1Input.focus();
  flamesForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

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

      setTimeout(() => {
        confetti.remove();
      }, 4000);
    }, i * 50);
  }
}

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

function rotateQuotes() {
  let currentIndex = 0;

  setInterval(() => {
    currentIndex = (currentIndex + 1) % romanticQuotes.length;
    quoteText.textContent = `"${romanticQuotes[currentIndex].text}"`;
    quoteAuthor.textContent = `- ${romanticQuotes[currentIndex].author}`;
  }, 8000);
}
