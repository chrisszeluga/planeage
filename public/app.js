(function () {
  const $id = (id) => document.getElementById(id);

  const form = $id('form');
  const viewSearch = $id('viewSearch');
  const viewResult = $id('viewResult');

  const flightInput = $id('flightNumber');
  const dateInput = $id('date');
  const errorEl = $id('error');

  const submitBtn = $id('submit');
  const spinner = $id('spinner');
  const buttonText = $id('buttonText');

  const flap0 = $id('flap0');
  const flap1 = $id('flap1');
  const flap2 = $id('flap2');
  const flap0Text = $id('flap0Text');
  const flap1Text = $id('flap1Text');
  const flap2Text = $id('flap2Text');

  const conditionDot = $id('conditionDot');
  const conditionText = $id('conditionText');
  const aircraftType = $id('aircraftType');
  const mfrYear = $id('mfrYear');
  const tail = $id('tail');
  const resetBtn = $id('reset');

  const ORIGINAL_BUTTON_TEXT = buttonText.textContent || 'Look up aircraft';
  const FETCH_TIMEOUT_MS = 15000;
  const ERR_UNAVAILABLE = 'Flight details currently unavailable.';
  let animationToken = 0;

  function localToday() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function sanitizeFlightNumber(value) {
    return String(value || '')
      .toUpperCase()
      .replace(/[^0-9A-Z\s]/g, '')
      .slice(0, 10);
  }

  function setHidden(el, hidden) {
    el.hidden = !!hidden;
  }

  function setError(message) {
    if (!message) {
      errorEl.textContent = '';
      setHidden(errorEl, true);
      return;
    }
    errorEl.textContent = message;
    setHidden(errorEl, false);
  }

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    flightInput.disabled = isLoading;
    dateInput.disabled = isLoading;

    setHidden(spinner, !isLoading);
    buttonText.textContent = isLoading ? 'Looking up…' : ORIGINAL_BUTTON_TEXT;
  }

  function showSearch() {
    setHidden(viewResult, true);
    setHidden(viewSearch, false);
    setError('');
    setLoading(false);
    animationToken++;
    flightInput.focus();
  }

  function showResult() {
    setHidden(viewSearch, true);
    setHidden(viewResult, false);
  }

  function conditionForAge(age) {
    if (age < 5) return { dot: 'var(--good)', text: 'New aircraft' };
    if (age < 15) return { dot: 'var(--warn)', text: 'Mid-life' };
    return { dot: 'var(--bad)', text: 'Veteran aircraft' };
  }

  function renderFlaps(age) {
    const token = ++animationToken;
    const safeAge = Number.isFinite(age) ? Math.max(0, age) : 0;
    const digits = String(safeAge).padStart(3, '0').split('');
    const showHundreds = safeAge >= 100;

    flap0.hidden = !showHundreds;
    flap0Text.textContent = '0';
    flap1Text.textContent = '0';
    flap2Text.textContent = '0';

    if (showHundreds) {
      animateFlap(flap0, flap0Text, Number(digits[0]) || 0, 100, token);
      animateFlap(flap1, flap1Text, Number(digits[1]) || 0, 250, token);
      animateFlap(flap2, flap2Text, Number(digits[2]) || 0, 400, token);
      return;
    }

    animateFlap(flap1, flap1Text, Number(digits[1]) || 0, 100, token);
    animateFlap(flap2, flap2Text, Number(digits[2]) || 0, 250, token);
  }

  function animateFlap(flapEl, textEl, target, delayMs, token) {
    let current = 0;

    setTimeout(() => {
      const step = () => {
        if (token !== animationToken) return;
        if (current >= target) return;
        current++;
        textEl.textContent = String(current);

        flapEl.classList.remove('is-flipping');
        requestAnimationFrame(() => {
          if (token !== animationToken) return;
          flapEl.classList.add('is-flipping');
          flapEl.addEventListener(
            'animationend',
            () => {
              flapEl.classList.remove('is-flipping');
            },
            { once: true }
          );
        });

        setTimeout(step, 60);
      };
      step();
    }, delayMs);
  }

  async function postJson(url, body) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      return { response, data };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function lookup() {
    setError('');

    const flightNumber = sanitizeFlightNumber(flightInput.value).trim();
    const date = String(dateInput.value || '').trim();

    if (!flightNumber || !date) {
      setError('Please fill in both fields');
      return;
    }

    setLoading(true);

    try {
      const { response, data } = await postJson('/check-flight', { flightNumber, date });
      if (!data) throw new Error('bad_json');

      if (!response.ok) {
        setError(data.message || ERR_UNAVAILABLE);
        return;
      }

      if (!data.ok) {
        setError(data.message || ERR_UNAVAILABLE);
        return;
      }

      const type =
        data.aircraftType || [data.manufacturer, data.model].filter(Boolean).join(' ') || '—';
      const year = data.year || '—';
      const reg = data.registration || (data.nNumber ? `N${data.nNumber}` : '—');
      const age = Number.isFinite(data.age) ? data.age : 0;

      const cond = conditionForAge(age);
      conditionDot.style.background = cond.dot;
      conditionText.textContent = cond.text;

      aircraftType.textContent = type;
      mfrYear.textContent = year;
      tail.textContent = reg;

      renderFlaps(age);
      showResult();
    } catch {
      setError(ERR_UNAVAILABLE);
    } finally {
      setLoading(false);
    }
  }

  flightInput.addEventListener('input', () => {
    const next = sanitizeFlightNumber(flightInput.value);
    if (flightInput.value !== next) flightInput.value = next;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    lookup();
  });

  resetBtn.addEventListener('click', () => {
    flightInput.value = '';
    dateInput.value = localToday();
    showSearch();
  });

  dateInput.value = localToday();
  showSearch();
})();
