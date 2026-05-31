/**
 * 极简 CDP (Chrome DevTools Protocol) 客户端。
 *
 * 使用 Node 22 内置 WebSocket，零依赖连接用户真实浏览器。
 * 关键能力：页面导航、JS 注入、截图、标签页管理。
 */

export class CDPClient {
  constructor() {
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    this.targetId = null;
    this.port = 9222;
  }

  /**
   * 连接到本地 Chrome 调试端口。
   * 优先创建一个全新的标签页来工作，避免干扰用户现有标签页。
   *
   * 关键改进：Chrome 调试端口 ready 不代表 /json/* 接口立刻可用，
   * 新启动的 Chrome 可能前几秒返回非 JSON 警告文本（如 "Using unsafe..."），
   * 所以这里做了带退避的重试。
   */
  async connect(port = 9222) {
    this.port = port;
    try {
      // 创建一个全新的标签页作为工作页（带重试）
      const target = await this._createNewTab(port);

      if (!target.webSocketDebuggerUrl) {
        throw new Error('未获取到 WebSocket 调试地址（Chrome 返回的调试目标缺少 webSocketDebuggerUrl 字段）');
      }

      this.targetId = target.id;
      this.ws = new WebSocket(target.webSocketDebuggerUrl);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket 连接超时（10秒）')), 10000);

        this.ws.onopen = async () => {
          clearTimeout(timeout);
          // 启用必要的功能域
          await this.send('Page.enable');
          await this.send('Runtime.enable');
          resolve();
        };

        this.ws.onerror = (err) => {
          clearTimeout(timeout);
          reject(new Error('WebSocket 错误: ' + (err.message || '未知')));
        };

        this.ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);

          if (msg.id && this.pending.has(msg.id)) {
            const { resolve: res, reject: rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error.message));
            else res(msg.result);
          } else if (msg.method) {
            const handlers = this.listeners.get(msg.method);
            if (handlers) {
              for (const h of handlers) h(msg.params);
            }
          }
        };
      });
    } catch (e) {
      throw new Error(
        `无法连接到浏览器 (端口 ${port}): ${e.message}\n` +
        `请确保 Chrome 已使用 --remote-debugging-port=${port} 启动。`
      );
    }
  }

  /**
   * 创建新标签页，带重试机制。
   * 
   * Chrome 130+ 要求 /json/new 使用 PUT（而非 GET），否则返回
   * "Using unsafe HTTP verb GET to invoke /json/new..."。
   * 为了兼容新旧版 Chrome，先尝试 PUT，失败后降级到 GET。
   */
  async _createNewTab(port, maxRetries = 6) {
    let lastError;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        // 先尝试 PUT（Chrome 130+ 要求），失败再 GET（旧版兼容）
        let text;
        for (const method of ['PUT', 'GET']) {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
              method,
              signal: AbortSignal.timeout(5000),
            });
            text = await res.text();
            if (text && text.trim() && (text.trim()[0] === '{' || text.trim()[0] === '[')) {
              break; // 拿到有效 JSON 就停
            }
          } catch { /* 换下一个方法继续 */ }
        }

        if (!text || !text.trim()) {
          throw new Error('Chrome 调试接口返回空响应');
        }

        // 检查是否为 JSON（以 { 或 [ 开头）
        const trimmed = text.trim();
        if (trimmed[0] !== '{' && trimmed[0] !== '[') {
          throw new Error(`Chrome 调试接口返回非 JSON 内容: "${trimmed.slice(0, 80)}..."`);
        }

        const target = JSON.parse(trimmed);
        return target;
      } catch (e) {
        lastError = e;
        if (i < maxRetries) {
          // 指数退避：500ms, 1s, 1.5s, 2s, 2.5s, 3s
          await this.sleep(500 * (i + 1));
        }
      }
    }
    throw lastError;
  }

  /** 发送 CDP 命令，返回 Promise。 */
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket 未连接'));
      }
      const id = this.msgId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 注册一次性事件监听（用完自动清除）。 */
  once(method, handler) {
    const wrapper = (...args) => {
      this._removeListener(method, wrapper);
      handler(...args);
    };
    this._addListener(method, wrapper);
  }

  /** 注册持久事件监听。 */
  on(method, handler) {
    this._addListener(method, handler);
  }

  _addListener(method, handler) {
    if (!this.listeners.has(method)) {
      this.listeners.set(method, new Set());
    }
    this.listeners.get(method).add(handler);
  }

  _removeListener(method, handler) {
    const set = this.listeners.get(method);
    if (set) set.delete(handler);
  }

  /**
   * 导航到指定 URL 并等待页面加载完成。
   * 使用 once() 避免监听器累积。
   */
  async goto(url, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时但页面可能已部分加载，不一定要失败
        resolve();
      }, timeoutMs);

      this.once('Page.loadEventFired', () => {
        clearTimeout(timer);
        resolve();
      });

      this.send('Page.navigate', { url }).catch(err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * 在当前页面执行 JavaScript 表达式，返回结果值。
   */
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description
        || res.exceptionDetails.text
        || 'Evaluate exception';
      throw new Error(desc);
    }
    return res.result.value;
  }

  /**
   * 等待页面中出现匹配 selector 的元素。
   * @param {string} selector CSS 选择器
   * @param {number} timeoutMs 超时毫秒
   * @returns {boolean} 是否找到
   */
  async waitForSelector(selector, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = await this.evaluate(
        `!!document.querySelector(${JSON.stringify(selector)})`
      );
      if (found) return true;
      await this.sleep(500);
    }
    return false;
  }

  /**
   * 对当前页面截图，返回 PNG 的 Buffer。
   */
  async screenshot() {
    const res = await this.send('Page.captureScreenshot', {
      format: 'png',
      quality: 80,
    });
    return Buffer.from(res.data, 'base64');
  }

  async mouseMove(x, y) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(x),
      y: Math.round(y),
      button: 'none',
    });
  }

  async mouseClick(x, y, { button = 'left', clickCount = 1, holdMs = 60 } = {}) {
    const btn = button === 'right' ? 'right' : 'left';
    const pressMs = Number.isFinite(Number(holdMs)) ? Math.max(0, Number(holdMs)) : 60;
    await this.mouseMove(x, y);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: Math.round(x),
      y: Math.round(y),
      button: btn,
      clickCount,
    });
    await this.sleep(pressMs);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: Math.round(x),
      y: Math.round(y),
      button: btn,
      clickCount,
    });
  }

  async mouseWheel(deltaX = 0, deltaY = 0, x = 400, y = 400) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(x),
      y: Math.round(y),
      deltaX,
      deltaY,
    });
  }

  async typeText(text, { minDelayMs = 35, maxDelayMs = 95 } = {}) {
    for (const ch of [...String(text || '')]) {
      await this.send('Input.insertText', { text: ch });
      const delay = minDelayMs + Math.random() * Math.max(0, maxDelayMs - minDelayMs);
      await this.sleep(delay);
    }
  }

  async keyPress(key) {
    const spec = keySpec(key);
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    });
    await this.sleep(40);
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
    });
  }

  /**
   * 获取当前页面的 URL。
   */
  async currentUrl() {
    return this.evaluate('window.location.href');
  }

  /** 睡眠指定毫秒。 */
  async sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * 关闭当前工作标签页并断开连接。
   */
  async close() {
    const targetId = this.targetId;
    const port = this.port;
    this.targetId = null;

    if (targetId && port) {
      // 等待 Chrome 确认关闭标签页，批处理才能确定上一批已经释放。
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`, { method: 'PUT' });
        if (!res.ok) {
          await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`);
        }
      } catch {
        try { await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`); } catch { /* ignore */ }
      }
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.pending.clear();
    this.listeners.clear();
  }
}

function keySpec(key) {
  if (key === 'Enter' || key === 'Return') {
    return { key: 'Enter', code: 'Enter', keyCode: 13 };
  }
  if (key === 'Escape') {
    return { key: 'Escape', code: 'Escape', keyCode: 27 };
  }
  throw new Error(`不支持的按键: ${key}`);
}
