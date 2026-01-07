/**
 * SubgroupX Landing Page Logic
 * Target Date: 2026-01-13T23:00:00+08:00
 */

// Target Date Configuration
const TARGET_DATE = new Date('2026-01-13T23:00:00+08:00');

// DOM Elements
const els = {
  days: document.getElementById('days'),
  hours: document.getElementById('hours'),
  minutes: document.getElementById('minutes'),
  seconds: document.getElementById('seconds'),
  countdown: document.getElementById('countdown'),
};

function updateCountdown() {
  const now = new Date();
  const diff = TARGET_DATE - now;

  if (diff <= 0) {
    // Launch Time
    els.countdown.innerHTML = '<div style="font-size: 2rem; color: var(--accent-magenta);">LAUNCH SEQUENCE INITIATED</div>';
    return;
  }

  // Calculate time components
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
  const minutes = Math.floor((diff / 1000 / 60) % 60);
  const seconds = Math.floor((diff / 1000) % 60);

  // Pad with zeros and update DOM
  els.days.textContent = Math.max(0, days).toString().padStart(3, '0');
  els.hours.textContent = Math.max(0, hours).toString().padStart(2, '0');
  els.minutes.textContent = Math.max(0, minutes).toString().padStart(2, '0');
  els.seconds.textContent = Math.max(0, seconds).toString().padStart(2, '0');
}

// Initialize
function init() {
  console.log('SubgroupX System Initialized');
  console.log('Target:', TARGET_DATE);
  
  updateCountdown();
  setInterval(updateCountdown, 1000);

  // Simple scroll reveal (optional enhancement)
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'translateY(0)';
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.feature-card, .text-block').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
  });
}

init();
