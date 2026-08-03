(function () {
  function sendBeacon(wrapper, payload) {
    var url = wrapper && wrapper.getAttribute('data-cv-track');
    if (!url) return;
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, JSON.stringify(payload));
        return;
      }
    } catch (e) { /* ignore sendBeacon failures */ }

    try {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {});
    } catch (e) { /* ignore fallback failures */ }
  }

  function initAccordions(wrapper) {
    var shop = wrapper.getAttribute('data-cv-shop');
    var productId = wrapper.getAttribute('data-cv-product');
    var productTitle = wrapper.getAttribute('data-cv-product-title') || "";

    wrapper.querySelectorAll('[data-cv-trigger]').forEach(function (trigger) {
      if (trigger.dataset.cvInit) return;
      trigger.dataset.cvInit = '1';
      trigger.addEventListener('click', function () {
        var isExpanded = trigger.getAttribute('aria-expanded') === 'true';

        // Close all
        wrapper.querySelectorAll('[data-cv-trigger]').forEach(function (t) {
          t.setAttribute('aria-expanded', 'false');
          var p = document.getElementById(t.getAttribute('aria-controls'));
          if (p) p.removeAttribute('data-open');
        });

        // Open clicked one and track
        if (!isExpanded) {
          trigger.setAttribute('aria-expanded', 'true');
          var panel = document.getElementById(trigger.getAttribute('aria-controls'));
          if (panel) panel.setAttribute('data-open', '');

          sendBeacon(wrapper, {
            shop: shop,
            productId: productId,
            productTitle: productTitle,
            fieldId: trigger.getAttribute('data-field-id'),
            fieldTitle: trigger.getAttribute('data-field-title'),
            action: 'expand',
          });
        }
      });
    });
  }

  function initTabScroll(nav) {
    if (!nav || nav.dataset.cvScrollInit) return;
    nav.dataset.cvScrollInit = '1';

    // Mouse wheel → horizontal scroll
    nav.addEventListener('wheel', function (e) {
      if (e.deltaY === 0) return;
      e.preventDefault();
      nav.scrollLeft += e.deltaY;
    }, { passive: false });

    // Click-drag → horizontal scroll
    var isDragging = false;
    var startX = 0;
    var scrollStart = 0;

    nav.addEventListener('mousedown', function (e) {
      isDragging = true;
      startX = e.pageX - nav.offsetLeft;
      scrollStart = nav.scrollLeft;
      nav.style.cursor = 'grabbing';
      nav.style.userSelect = 'none';
    });

    nav.addEventListener('mouseleave', function () {
      isDragging = false;
      nav.style.cursor = '';
      nav.style.userSelect = '';
    });

    nav.addEventListener('mouseup', function () {
      isDragging = false;
      nav.style.cursor = '';
      nav.style.userSelect = '';
    });

    nav.addEventListener('mousemove', function (e) {
      if (!isDragging) return;
      e.preventDefault();
      var x = e.pageX - nav.offsetLeft;
      nav.scrollLeft = scrollStart - (x - startX);
    });
  }

  function initTabs(wrapper) {
    var shop = wrapper.getAttribute('data-cv-shop');
    var productId = wrapper.getAttribute('data-cv-product');
    var productTitle = wrapper.getAttribute('data-cv-product-title') || "";
    var buttons = wrapper.querySelectorAll('.cv-tab-btn');
    var panels = wrapper.querySelectorAll('.cv-tab-panel');

    buttons.forEach(function (btn) {
      if (btn.dataset.cvInit) return;
      btn.dataset.cvInit = '1';
      btn.addEventListener('click', function () {
        var idx = btn.getAttribute('data-tab');

        buttons.forEach(function (b) { b.classList.remove('cv-tab-active'); });
        panels.forEach(function (p) { p.classList.remove('cv-tab-panel-active'); });

        btn.classList.add('cv-tab-active');
        var panel = wrapper.querySelector('[data-panel="' + idx + '"]');
        if (panel) panel.classList.add('cv-tab-panel-active');

        sendBeacon(wrapper, {
          shop: shop,
          productId: productId,
          productTitle: productTitle,
          fieldId: btn.getAttribute('data-field-id'),
          fieldTitle: btn.getAttribute('data-field-title'),
          action: 'tab_click',
        });
      });
    });
  }

  function init(root) {
    var ctx = root || document;
    ctx.querySelectorAll('[data-cv-accordion]').forEach(function (el) {
      initAccordions(el.closest('.cv-block-wrapper') || el);
    });
    ctx.querySelectorAll('[data-cv-tabs]').forEach(function (el) {
      var wrapper = el.closest('.cv-block-wrapper') || el;
      initTabScroll(wrapper.querySelector('.cv-tab-nav'));
      initTabs(wrapper);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }

  document.addEventListener('shopify:section:load', function (e) { init(e.target); });
})();
