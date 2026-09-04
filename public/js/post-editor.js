/**
 * 校园墙 - 可视化帖子编辑器
 * 编辑时使用 contenteditable 直接显示粗体/斜体，提交时兼容站内已有的 Markdown 标记。
 */
(function (window, document) {
  'use strict';

  var DEFAULT_EMOJIS = ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😋','😛','🤪','😜','🤗','🤭','🙄','😒','😌','😔','😴','🤤','😷','🤒','🤕','🤢','🥵','🥶','🥴','🤯','🤠','🥳','😎','🤓','🧐','😺','😸','😹','😻','😼','😽','🙀','😿','😾','👋','👏','🙌','👐','🤲','🙏','💪','🤝','👍','👎','👊','✊','🤛','🤜','☝️','✋','🤚','🖐️','🖖','👌','🤌','✌️','🤘','🤟','👈','👉','👆','🖕','👇','💯','🔥','⭐','🌟','💫','✨','💥','💢','💬','💭','🗯️','💤','🏃','🚶','💃','🕺','🏄','🏊','🚴','🚵','🎮','🎯','🎲','🧩','🎭','🎨','🎬','🎤','🎧','🎵','🎶','🎹','🎸','🎺','🎷','🪘','🎻','🏆','🥇','🥈','🥉','🏅','🎖','🏵','🎗','🎫','🎟','🎪','🤹','🛋️','🛍️','🛒','📱','💻','🖥️','⌨️','🖱️','🖲','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🧭','⏰','⏱️','⏲️','🕰️','⌚','📡','🔋','🔌','💡','🔦','🕯️','🧯','💸','💵','💴','💶','💷','💰','💳','💎','⚖️','🔧','🔨','⚒️','🛠️','⛏️','🔩','⚙️','🧱','⛓️','🧲','🔫','💣','🧨','🪓','🔪','🗡️','⚔️','🛡️','🚬','⚰️','🪦','⚱️','🏺','🔮','📿','🧿','💈','⚗️','🔭','🔬','🕳️','🩹','🩺','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡️','🧹','🪠','🧷','🧸','🧰','📌','📍','✂️','🖊️','🖋️','✒️','📏','📐','🗃️','🗄️','🗑️','📈','📉','📊','📋','🗒️','🗓️','📔','📕','📖','📗','📘','📙','📚','📃','📄','📑','🗞️','📰','🗼','🗽','⛪','🕌','🛕','🕍','⛩️','🕋','⛲','⛺','🌁','🌂','☂️','⛱️','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️','☃️','⛄','🌬️','🌪️','🌫️','☔','⚡','🌈'];
  window.CampusWallPostEmojis = DEFAULT_EMOJIS;

  function createEditor(options) {
    options = options || {};
    var storage = options.storage;
    var surface = options.surface;
    var picker = options.picker;
    var trigger = options.trigger;
    var emojis = options.emojis || [];
    var maxLength = options.maxLength || 5000;
    var savedRange = null;
    var originalPickerParent = null;
    var originalPickerNextSibling = null;

    if (!storage || !surface) return null;

    function isInside(node) {
      return node === surface || (node && surface.contains(node));
    }

    function getSelectionRange() {
      var selection = window.getSelection();
      if (!selection || !selection.rangeCount) return null;
      var range = selection.getRangeAt(0);
      return isInside(range.commonAncestorContainer) ? range : null;
    }

    function saveSelection() {
      var range = getSelectionRange();
      if (range) savedRange = range.cloneRange();
    }

    function focusSurface() {
      try { surface.focus({ preventScroll: true }); } catch (e) { surface.focus(); }
    }

    function restoreSelection() {
      focusSurface();
      var selection = window.getSelection();
      if (savedRange && isInside(savedRange.commonAncestorContainer)) {
        selection.removeAllRanges();
        selection.addRange(savedRange);
        return savedRange;
      }
      var range = document.createRange();
      range.selectNodeContents(surface);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      savedRange = range.cloneRange();
      return range;
    }

    function serializeNode(node) {
      if (node.nodeType === 3) return node.nodeValue.replace(/\u00a0/g, ' ');
      if (node.nodeType !== 1) return '';
      if (node.tagName === 'BR') return '\n';

      var children = '';
      for (var i = 0; i < node.childNodes.length; i++) children += serializeNode(node.childNodes[i]);
      if (node.tagName === 'B' || node.tagName === 'STRONG') return '**' + children + '**';
      if (node.tagName === 'I' || node.tagName === 'EM') return '*' + children + '*';
      if (node.tagName === 'DIV' || node.tagName === 'P' || node.tagName === 'LI') {
        return children + (children && !/\n$/.test(children) ? '\n' : '');
      }
      return children;
    }

    function serialize() {
      var value = serializeNode(surface).replace(/\n+$/, '');
      return value.length > maxLength ? value.slice(0, maxLength) : value;
    }

    function appendInline(fragment, text) {
      var pattern = /(\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*)/g;
      var last = 0;
      var match;
      while ((match = pattern.exec(text))) {
        if (match.index > last) fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
        if (match[2]) {
          var both = document.createElement('strong');
          var bothItalic = document.createElement('em');
          bothItalic.textContent = match[2];
          both.appendChild(bothItalic);
          fragment.appendChild(both);
        } else if (match[3]) {
          var bold = document.createElement('strong');
          bold.textContent = match[3];
          fragment.appendChild(bold);
        } else {
          var italic = document.createElement('em');
          italic.textContent = match[4];
          fragment.appendChild(italic);
        }
        last = pattern.lastIndex;
      }
      if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
    }

    function setValue(value) {
      var lines = String(value || '').split('\n');
      var fragment = document.createDocumentFragment();
      lines.forEach(function (line, index) {
        appendInline(fragment, line);
        if (index < lines.length - 1) fragment.appendChild(document.createElement('br'));
      });
      surface.replaceChildren(fragment);
      savedRange = null;
      sync();
    }

    function getValue() {
      storage.value = serialize();
      return storage.value;
    }

    function getTextLength() {
      return getValue().replace(/\*\*\*/g, '').replace(/\*\*/g, '').replace(/\*/g, '').length;
    }

    function sync() {
      storage.value = serialize();
      if (typeof options.onChange === 'function') options.onChange(storage.value, getTextLength());
    }

    function setPickerVisible(visible) {
      if (!picker) return;
      picker.classList.toggle('show', visible);
      if (trigger) trigger.setAttribute('aria-expanded', visible ? 'true' : 'false');
    }

    function placePickerForViewport() {
      if (!picker) return;
      if (window.innerWidth <= 768) {
        if (!originalPickerParent) {
          originalPickerParent = picker.parentNode;
          originalPickerNextSibling = picker.nextSibling;
          document.body.appendChild(picker);
        }
      } else if (originalPickerParent) {
        if (originalPickerNextSibling && originalPickerNextSibling.parentNode === originalPickerParent) {
          originalPickerParent.insertBefore(picker, originalPickerNextSibling);
        } else {
          originalPickerParent.appendChild(picker);
        }
        originalPickerParent = null;
        originalPickerNextSibling = null;
      }
    }

    function insertEmoji(emoji) {
      var range = restoreSelection();
      range.deleteContents();
      var node = document.createTextNode(emoji);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      savedRange = range.cloneRange();
      sync();
      setPickerVisible(false);
    }

    function format(type) {
      var range = restoreSelection();
      if (range.collapsed) {
        var placeholder = document.createTextNode(type === 'bold' ? '粗体文字' : '斜体文字');
        range.insertNode(placeholder);
        range.selectNode(placeholder);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      focusSurface();
      try { document.execCommand(type, false, null); } catch (e) {}
      saveSelection();
      sync();
    }

    function showPicker() {
      if (!picker) return;
      placePickerForViewport();
      if (picker.classList.contains('show')) {
        setPickerVisible(false);
        return;
      }
      saveSelection();
      picker.replaceChildren();
      emojis.forEach(function (emoji) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'emoji-item';
        button.textContent = emoji;
        button.setAttribute('aria-label', '插入表情 ' + emoji);
        button.addEventListener('mousedown', function (event) { event.preventDefault(); });
        button.addEventListener('click', function () { insertEmoji(emoji); });
        picker.appendChild(button);
      });
      setPickerVisible(true);
    }

    function closeOnOutsideClick(event) {
      if (!picker || !picker.classList.contains('show')) return;
      var target = event.target;
      if (picker.contains(target) || target === trigger || (target && trigger && trigger.contains(target)) || target === surface || surface.contains(target)) return;
      setPickerVisible(false);
    }

    surface.addEventListener('input', sync);
    surface.addEventListener('keyup', saveSelection);
    surface.addEventListener('mouseup', saveSelection);
    surface.addEventListener('touchend', saveSelection, { passive: true });
    surface.addEventListener('blur', saveSelection, { passive: true });
    document.addEventListener('selectionchange', function () {
      if (getSelectionRange()) saveSelection();
    });
    document.addEventListener('click', closeOnOutsideClick);
    window.addEventListener('resize', placePickerForViewport);
    if (picker) placePickerForViewport();
    sync();

    return {
      getValue: getValue,
      setValue: setValue,
      sync: sync,
      getTextLength: getTextLength,
      format: format,
      insertEmoji: insertEmoji,
      showPicker: showPicker,
      closePicker: function () { setPickerVisible(false); },
      surface: surface,
      storage: storage
    };
  }

  window.CampusWallPostEditor = { create: createEditor };
}(window, document));
