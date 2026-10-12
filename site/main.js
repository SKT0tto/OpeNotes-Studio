// OpeNotes Studio landing page: small progressive enhancements only; the page works without JS.
(function () {
  'use strict';
  var nav = document.querySelector('.nav');
  var toggle = document.querySelector('.nav-toggle');
  var menu = document.getElementById('nav-menu');

  function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  function setMenu(open) {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
    menu.classList.toggle('open', open);
    nav.classList.toggle('menu-open', open);
  }
  toggle.addEventListener('click', function () { setMenu(toggle.getAttribute('aria-expanded') !== 'true'); });
  menu.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { setMenu(false); toggle.focus(); }
  });

  // Placeholder links (repository / download / demo are not published yet).
  var toast = document.querySelector('.toast');
  var toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2600);
  }
  document.querySelectorAll('a[data-soon]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      if (a.getAttribute('href') !== '#') return; // real URL filled in: follow it
      e.preventDefault();
      showToast(a.getAttribute('data-soon'));
    });
  });

  // Copy buttons on code blocks.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) resolve(); else reject(new Error('copy failed')); } catch (err) { reject(err); }
      document.body.removeChild(ta);
    });
  }
  document.querySelectorAll('.copy').forEach(function (btn) {
    var label = btn.querySelector('span');
    btn.addEventListener('click', function () {
      var code = btn.parentElement.querySelector('code');
      var text = code.textContent.split(/\r?\n/)
        .filter(function (l) { return l.trim() && l.trim().charAt(0) !== '#'; })
        .map(function (l) { return l.replace(/\s+#.*$/, ''); })
        .join('\n');
      copyText(text).then(function () {
        btn.classList.add('done'); label.textContent = '已复制';
        btn.querySelector('use').setAttribute('href', '#i-check');
        showToast('已复制到剪贴板');
      }, function () { showToast('复制失败，请手动选择文本'); }).then(function () {
        setTimeout(function () {
          btn.classList.remove('done'); label.textContent = '复制';
          btn.querySelector('use').setAttribute('href', '#i-copy');
        }, 1800);
      });
    });
  });

  // Confetti burst on primary CTA hover/focus (original shapes, short-lived).
  var motionOk = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var colors = ['#FF3B72', '#33CCFF', '#FFD23F', '#8B5CF6', '#FF8A3D'];
  function confetti(btn) {
    if (!motionOk || btn.querySelector('.cf')) return;
    var box = document.createElement('span');
    box.className = 'cf';
    box.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 14; i++) {
      var p = document.createElement('i');
      var a = (i / 14) * Math.PI * 2 + Math.random() * 0.4;
      var d = 46 + Math.random() * 40;
      p.style.setProperty('--dx', Math.cos(a) * d + 'px');
      p.style.setProperty('--dy', Math.sin(a) * d - 14 + 'px');
      p.style.setProperty('--rot', Math.round(Math.random() * 540 - 270) + 'deg');
      p.style.background = colors[i % colors.length];
      box.appendChild(p);
    }
    btn.appendChild(box);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 900);
  }
  document.querySelectorAll('.btn-primary').forEach(function (b) {
    b.addEventListener('mouseenter', function () { confetti(b); });
    b.addEventListener('focus', function () { confetti(b); });
  });

  // Reveal on scroll.
  var items = document.querySelectorAll('.reveal');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    items.forEach(function (el, i) { el.style.transitionDelay = (i % 3) * 70 + 'ms'; io.observe(el); });
  }
})();
