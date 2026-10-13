// Progressive enhancement for the docs pages: wide tables scroll, headings get
// permalinks, and the right rail becomes a table of contents that tracks reading
// position. Everything degrades to plain markdown output without this file.
(function () {
  'use strict';

  var prose = document.querySelector('.prose');
  if (!prose) return;

  // ASCII network diagrams must keep their columns lined up. Box-drawing glyphs are
  // missing from most webfonts, so anything containing them falls back to the system
  // mono — belt and braces alongside the `{: .diagram}` class in the markdown.
  prose.querySelectorAll('pre').forEach(function (pre) {
    if (/[\u2500-\u257f]/.test(pre.textContent)) pre.classList.add('diagram');
  });

  // Wide tables (the topology and variable matrices) scroll instead of overflowing.
  prose.querySelectorAll('table').forEach(function (table) {
    var wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.parentNode.insertBefore(wrap, table);
    wrap.appendChild(table);
  });

  var headings = Array.prototype.filter.call(
    prose.querySelectorAll('h2[id], h3[id]'),
    function (h) { return h.id; }
  );

  // capture the labels before the permalinks are appended to the headings
  var labels = {};
  headings.forEach(function (heading) {
    labels[heading.id] = heading.textContent.trim();
  });

  headings.forEach(function (heading) {
    var anchor = document.createElement('a');
    anchor.className = 'anchor';
    anchor.href = '#' + heading.id;
    anchor.textContent = '#';
    anchor.setAttribute('aria-label', 'Link to this section');
    heading.appendChild(anchor);
  });

  var sections = headings.filter(function (h) { return h.tagName === 'H2'; });
  if (sections.length < 2) return;

  var toc = document.getElementById('toc');
  var list = document.getElementById('toc-list');
  if (!toc || !list) return;

  var links = {};

  sections.forEach(function (heading) {
    var item = document.createElement('li');
    var link = document.createElement('a');
    link.href = '#' + heading.id;
    link.textContent = labels[heading.id];
    item.appendChild(link);
    list.appendChild(item);
    links[heading.id] = link;
  });

  toc.hidden = false;

  if (!('IntersectionObserver' in window)) return;

  var active = null;

  function setActive(id) {
    if (id === active) return;
    if (active && links[active]) links[active].removeAttribute('aria-current');
    active = id;
    if (active && links[active]) links[active].setAttribute('aria-current', 'true');
  }

  var visible = new Set();

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        visible.add(entry.target.id);
      } else {
        visible.delete(entry.target.id);
      }
    });

    for (var i = 0; i < sections.length; i++) {
      if (visible.has(sections[i].id)) {
        setActive(sections[i].id);
        return;
      }
    }
  }, { rootMargin: '-5rem 0px -70% 0px' });

  sections.forEach(function (heading) { observer.observe(heading); });
})();
