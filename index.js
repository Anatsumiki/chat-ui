/* ================================================================
   AI Chat — Application Logic
   ================================================================ */

(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────
  var CONFIG_KEY = 'chat_ui_config';
  var CONV_KEY = 'chat_ui_conversations';

  // ── State ──────────────────────────────────────────────────────
  var config = {
    endpoint: '',
    model: '',
    systemPrompt: '你是一个有帮助的 AI 助手。',
    maxTokens: 2048,
    temperature: 0.7,
  };

  var conversations = [];
  var activeConvId = null;
  var isStreaming = false;
  var abortController = null;

  // ── DOM Refs ───────────────────────────────────────────────────
  var $ = function (id) {
    return document.getElementById(id);
  };

  var sidebar = $('sidebar');
  var collapseBtn = $('collapseSidebarBtn');
  var sidebarToggleFab = $('sidebarToggleFab');
  var convList = $('convList');
  var convSearch = $('convSearch');
  var newChatBtn = $('newChatBtn');
  var messagesContainer = $('messagesContainer');
  var messagesInner = $('messagesInner');
  var emptyState = $('emptyState');
  var chatInput = $('chatInput');
  var sendBtn = $('sendBtn');
  var convTitleDisplay = $('convTitleDisplay');
  var modelBadge = $('modelBadge');
  var apiStatus = $('apiStatus');
  var clearChatBtn = $('clearChatBtn');
  var apiSettingsBtn = $('apiSettingsBtn');
  var apiModal = $('apiModal');
  var apiModalClose = $('apiModalClose');
  var apiModalCancel = $('apiModalCancel');
  var apiModalSave = $('apiModalSave');
  var toastContainer = $('toastContainer');
  var apiEndpointInput = $('apiEndpoint');
  var modelSelectInput = $('modelSelect');
  var systemPromptInput = $('systemPrompt');
  var maxTokensInput = $('maxTokens');
  var temperatureInput = $('temperature');

  // ── Persistence ────────────────────────────────────────────────

  function loadStorage() {
    try {
      var rawConfig = localStorage.getItem(CONFIG_KEY);
      if (rawConfig) {
        Object.assign(config, JSON.parse(rawConfig));
      }
      var rawConversations = localStorage.getItem(CONV_KEY);
      if (rawConversations) {
        conversations = JSON.parse(rawConversations);
      }
    } catch (e) {
      /* corrupted data — start fresh */
    }
    if (!config.systemPrompt) {
      config.systemPrompt = '你是一个有帮助的 AI 助手。';
    }
  }

  function saveConfig() {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    updateStatusIndicators();
  }

  function saveConversations() {
    localStorage.setItem(CONV_KEY, JSON.stringify(conversations));
  }

  // ── Utilities ──────────────────────────────────────────────────

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function toast(message, type) {
    var el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.remove();
    }, 3000);
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Markdown Renderer ──────────────────────────────────────────

  function renderMessage(text) {
    var html = escapeHtml(text);

    // fenced code blocks
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, function (_, lang, code) {
      var langAttr = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
      return (
        '<pre><code' +
        langAttr +
        '>' +
        code.replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</code></pre>'
      );
    });

    // inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // bold + italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // paragraph splitting (double newline)
    var paragraphs = html.split(/\n\n+/);
    if (paragraphs.length > 1) {
      html = paragraphs
        .map(function (p) {
          var trimmed = p.trim();
          if (!trimmed) return '';
          if (trimmed.startsWith('<pre>') || trimmed.startsWith('<pre ')) {
            return trimmed;
          }
          return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
        })
        .join('');
    } else {
      html = html.replace(/\n/g, '<br>');
    }

    return html;
  }

  // ── Status Indicators ──────────────────────────────────────────

  function updateStatusIndicators() {
    var isConfigured = config.endpoint && config.model;
    modelBadge.textContent = config.model || '未配置';
    apiStatus.innerHTML = isConfigured
      ? '<span class="status-connected">&#9679; 已连接 (' +
        escapeHtml(config.model) +
        ')</span>'
      : '<span class="status-disconnected">&#9679; API 未配置</span>';
  }

  // ── Conversation CRUD ──────────────────────────────────────────

  function createConversation(firstMessage, firstReply) {
    var now = Date.now();
    var conv = {
      id: generateId(),
      title: firstMessage
        ? firstMessage.slice(0, 40) + (firstMessage.length > 40 ? '…' : '')
        : '新对话',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    if (firstMessage) {
      conv.messages.push({ role: 'user', content: firstMessage, ts: now });
    }
    if (firstReply) {
      conv.messages.push({
        role: 'assistant',
        content: firstReply,
        ts: Date.now(),
      });
    }
    conversations.unshift(conv);
    activeConvId = conv.id;
    saveConversations();
    renderConvList();
    renderActiveConv();
    return conv;
  }

  function getActiveConv() {
    for (var i = 0; i < conversations.length; i++) {
      if (conversations[i].id === activeConvId) return conversations[i];
    }
    return null;
  }

  function setActiveConv(id) {
    activeConvId = id;
    renderConvList();
    renderActiveConv();
    if (window.innerWidth <= 768) {
      sidebar.classList.add('collapsed');
    }
  }

  function deleteConv(id) {
    conversations = conversations.filter(function (c) {
      return c.id !== id;
    });
    if (activeConvId === id) {
      activeConvId = conversations.length > 0 ? conversations[0].id : null;
    }
    saveConversations();
    renderConvList();
    renderActiveConv();
  }

  // ── Render — Conversation List ─────────────────────────────────

  function renderConvList() {
    var query = convSearch.value.toLowerCase().trim();
    var filtered = query
      ? conversations.filter(function (c) {
          return c.title.toLowerCase().includes(query);
        })
      : conversations;

    convList.innerHTML = filtered
      .map(function (c) {
        var activeClass = c.id === activeConvId ? ' active' : '';
        var timeStr = new Date(c.updatedAt).toLocaleDateString('zh-CN', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        return (
          '<div class="conv-item' +
          activeClass +
          '" data-id="' +
          c.id +
          '">' +
          '<span class="conv-icon">&#128172;</span>' +
          '<div class="conv-info">' +
          '<div class="conv-title">' +
          escapeHtml(c.title) +
          '</div>' +
          '<div class="conv-meta">' +
          timeStr +
          ' · ' +
          c.messages.length +
          ' 条消息</div>' +
          '</div>' +
          '</div>'
        );
      })
      .join('');

    /* attach event handlers */
    var items = convList.querySelectorAll('.conv-item');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function () {
        var id = this.dataset.id;
        if (id) setActiveConv(id);
      });
      items[i].addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var id = this.dataset.id;
        if (id && confirm('确定删除该对话？')) deleteConv(id);
        return false;
      });
    }
  }

  // ── Render — Active Conversation ───────────────────────────────

  function renderActiveConv() {
    var conv = getActiveConv();

    if (!conv || conv.messages.length === 0) {
      emptyState.style.display = 'flex';
      messagesInner.style.display = 'none';
      messagesInner.innerHTML = '';
      convTitleDisplay.textContent = '新对话';
      return;
    }

    emptyState.style.display = 'none';
    messagesInner.style.display = 'block';
    convTitleDisplay.textContent = escapeHtml(conv.title);

    messagesInner.innerHTML = conv.messages
      .map(function (m, idx) {
        var isUser = m.role === 'user';
        var avatarClass = isUser ? 'user' : 'assistant';
        var avatarLabel = isUser ? 'U' : 'AI';
        var nameLabel = isUser ? '你' : 'AI';
        var htmlContent = renderMessage(m.content);

        return (
          '<div class="msg ' +
          (isUser ? 'user' : '') +
          '" data-index="' +
          idx +
          '">' +
          '<div class="msg-avatar ' +
          avatarClass +
          '">' +
          avatarLabel +
          '</div>' +
          '<div class="msg-body">' +
          '<div class="msg-name">' +
          nameLabel +
          '</div>' +
          '<div class="msg-content">' +
          htmlContent +
          '</div>' +
          '<div class="msg-actions">' +
          '<button class="copy-msg-btn" title="复制">&#128203; 复制</button>' +
          '</div>' +
          '</div>' +
          '</div>'
        );
      })
      .join('');

    /* attach copy button handlers */
    var copyButtons = messagesInner.querySelectorAll('.copy-msg-btn');
    for (var j = 0; j < copyButtons.length; j++) {
      copyButtons[j].addEventListener('click', function () {
        var msgEl = this.closest('.msg');
        var contentEl = msgEl.querySelector('.msg-content');
        navigator.clipboard.writeText(contentEl.textContent).then(
          function () {
            toast('已复制');
          },
          function () {
            /* clipboard declined — silent fail */
          },
        );
      });
    }

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // ── Send Message ───────────────────────────────────────────────

  async function sendMessage(text) {
    if (isStreaming || !text.trim()) return;

    /* validate config */
    if (!config.endpoint || !config.model) {
      toast('请先在 API 配置中填写端点、密钥和模型名称', 'error');
      apiModal.classList.add('open');
      return;
    }

    /* enter streaming mode */
    isStreaming = true;
    sendBtn.disabled = true;
    chatInput.disabled = true;

    /* ensure active conversation exists */
    var conv = getActiveConv();
    if (!conv) {
      conv = createConversation(text, null);
    } else {
      conv.messages.push({ role: 'user', content: text, ts: Date.now() });
      conv.title =
        conv.messages[0].content.slice(0, 40) +
        (conv.messages[0].content.length > 40 ? '…' : '');
      conv.updatedAt = Date.now();
      saveConversations();
    }
    renderConvList();
    renderActiveConv();

    /* scroll to latest message */
    setTimeout(function () {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }, 50);

    /* show placeholder bubble */
    emptyState.style.display = 'none';
    messagesInner.style.display = 'block';
    var placeholderDiv = document.createElement('div');
    placeholderDiv.className = 'msg assistant';
    placeholderDiv.innerHTML =
      '<div class="msg-avatar assistant">AI</div>' +
      '<div class="msg-body">' +
      '<div class="msg-name">AI</div>' +
      '<div class="msg-content">' +
      '<div class="typing-indicator">' +
      '<span></span><span></span><span></span>' +
      '</div>' +
      '</div>' +
      '</div>';
    messagesInner.appendChild(placeholderDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    /* build payload */
    var payloadMessages = [];
    if (config.systemPrompt) {
      payloadMessages.push({ role: 'system', content: config.systemPrompt });
    }
    conv = getActiveConv();
    if (conv) {
      conv.messages.forEach(function (m) {
        payloadMessages.push({ role: m.role, content: m.content });
      });
    }

    /* send request */
    abortController = new AbortController();
    var fullReply = '';

    try {
      const response = await fetch('/.netlify/functions/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: payloadMessages,
          model: config.model,
          endpoint: config.endpoint, // 端点传给服务端
          maxTokens: config.maxTokens,
          temperature: config.temperature,
          systemPrompt: config.systemPrompt,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        var errText = '';
        try {
          errText = await response.text();
        } catch (e) {
          /* ignore */
        }
        throw new Error('HTTP ' + response.status + ': ' + errText);
      }

      /* stream reader */
      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var firstChunk = true;

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (var i = 0; i < lines.length; i++) {
          var trimmed = lines[i].trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            var json = JSON.parse(trimmed.slice(6));
            var delta = json.choices?.[0]?.delta?.content || '';
            if (delta) {
              fullReply += delta;
              var contentDiv = placeholderDiv.querySelector('.msg-content');
              if (contentDiv) {
                contentDiv.innerHTML =
                  renderMessage(fullReply) +
                  '<div class="typing-indicator">' +
                  '<span></span><span></span><span></span>' +
                  '</div>';
              }
              if (firstChunk) firstChunk = false;
              messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
          } catch (e) {
            /* skip malformed chunks */
          }
        }
      }

      /* process any trailing buffer */
      if (buffer.trim() && buffer.trim() !== 'data: [DONE]') {
        var tb = buffer.trim();
        if (tb.startsWith('data: ')) {
          try {
            var j = JSON.parse(tb.slice(6));
            var d = j.choices?.[0]?.delta?.content || '';
            if (d) fullReply += d;
          } catch (e) {
            /* ignore */
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        toast('请求失败: ' + err.message, 'error');
        console.error(err);
      }
    }

    /* finalize */
    placeholderDiv.remove();

    if (fullReply) {
      conv = getActiveConv();
      if (conv) {
        conv.messages.push({
          role: 'assistant',
          content: fullReply,
          ts: Date.now(),
        });
        conv.updatedAt = Date.now();
        saveConversations();
        renderConvList();
        renderActiveConv();
      }
    }

    isStreaming = false;
    sendBtn.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
    abortController = null;
  }

  // ── Event: Send Message ────────────────────────────────────────

  function handleSend() {
    var text = chatInput.value.trim();
    if (text) {
      chatInput.value = '';
      chatInput.style.height = 'auto';
      sendMessage(text);
    }
  }

  chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  chatInput.addEventListener('input', function () {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
  });

  sendBtn.addEventListener('click', handleSend);

  // ── Event: New Chat ────────────────────────────────────────────

  newChatBtn.addEventListener('click', function () {
    activeConvId = null;
    emptyState.style.display = 'flex';
    messagesInner.style.display = 'none';
    messagesInner.innerHTML = '';
    convTitleDisplay.textContent = '新对话';
    renderConvList();
    chatInput.focus();
  });

  // ── Event: Sidebar Collapse ────────────────────────────────────

  collapseBtn.addEventListener('click', function () {
    sidebar.classList.toggle('collapsed');
  });

  sidebarToggleFab.addEventListener('click', function () {
    sidebar.classList.remove('collapsed');
  });

  // ── Event: Search Conversations ────────────────────────────────

  convSearch.addEventListener('input', renderConvList);

  // ── Event: Clear Chat ──────────────────────────────────────────

  clearChatBtn.addEventListener('click', function () {
    var conv = getActiveConv();
    if (!conv) return;
    if (!confirm('确定清空当前对话的所有消息？')) return;
    conv.messages = [];
    conv.updatedAt = Date.now();
    saveConversations();
    renderConvList();
    renderActiveConv();
  });

  // ── Modal: API Settings ────────────────────────────────────────

  function openApiModal() {
    apiEndpointInput.value = config.endpoint || '';
    modelSelectInput.value = config.model || '';
    systemPromptInput.value = config.systemPrompt || '';
    maxTokensInput.value = config.maxTokens || 2048;
    temperatureInput.value = config.temperature || 0.7;
    apiModal.classList.add('open');
    apiEndpointInput.focus();
  }

  function closeApiModal() {
    apiModal.classList.remove('open');
  }

  apiSettingsBtn.addEventListener('click', openApiModal);
  apiModalClose.addEventListener('click', closeApiModal);
  apiModalCancel.addEventListener('click', closeApiModal);
  apiModal.addEventListener('click', function (e) {
    if (e.target === apiModal) closeApiModal();
  });

  apiModalSave.addEventListener('click', function () {
    config.endpoint = apiEndpointInput.value.trim();
    config.model = modelSelectInput.value.trim();
    config.systemPrompt =
      systemPromptInput.value.trim() || '你是一个有帮助的 AI 助手。';
    config.maxTokens = parseInt(maxTokensInput.value) || 2048;
    config.temperature = parseFloat(temperatureInput.value) || 0.7;
    saveConfig();
    toast('配置已保存');
    closeApiModal();
  });

  // ── Init ───────────────────────────────────────────────────────

  function init() {
    loadStorage();
    updateStatusIndicators();

    if (conversations.length > 0) {
      activeConvId = conversations[0].id;
    }

    renderConvList();
    renderActiveConv();
    chatInput.focus();

    /* keyboard shortcut: Ctrl+K → API settings */
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        openApiModal();
      }
    });
  }

  init();
})();
