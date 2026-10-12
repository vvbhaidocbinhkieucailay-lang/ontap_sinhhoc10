/* Thi thử Sinh học 10 — logic giao diện.
 * NGUYÊN TẮC: không tính điểm ở client, không gửi điểm lên server,
 * không nhúng đáp án/bí mật vào file này. Mọi chấm điểm do máy chủ thực hiện. */
(function () {
"use strict";

/* ================= Helpers ================= */
function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
/* Định dạng số theo tiếng Việt: 7.25 -> "7,25" */
function fmtNumVI(n) {
  if (n === null || n === undefined || n === "") return "—";
  return String(n).replace(".", ",");
}
function fmtDateTimeVI(iso) {
  try {
    return new Date(iso).toLocaleString("vi-VN", {
      timeZone: "Asia/Ho_Chi_Minh",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  } catch (e) { return iso; }
}
function fmtClockVI(iso) {
  try {
    return new Date(iso).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" });
  } catch (e) { return ""; }
}
function uuid4() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  var s = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
  return s;
}

/* ================= Config ================= */
var EXAM = window.EXAM_DATA || null;
var APP_CONFIG = window.APP_CONFIG || null;
var APPS_SCRIPT_URL = (APP_CONFIG && APP_CONFIG.APPS_SCRIPT_URL) || "";
var CONFIG_OK = !!APPS_SCRIPT_URL && APPS_SCRIPT_URL.indexOf("REPLACE_ME") === -1 &&
                (APPS_SCRIPT_URL.indexOf("https://") === 0 ||
                 (APPS_SCRIPT_URL.indexOf("http://") === 0 && window.location.protocol === "http:"));
// Trang https (GitHub Pages) bắt buộc API https để tránh mixed-content;
// cho phép http khi tự kiểm thử trên trang http nội bộ.
var MA_DE = "101";   // chỉ để hiển thị; mã dự thi do học sinh nhập ở form và máy chủ kiểm tra
var DRAFT_PREFIX = "sh10_thithu_101_";    // key nháp: sh10_thithu_101_<maHS>_<attemptId>

/* ================= State ================= */
var state = {
  attempt: null,        // {attemptId, hoTen, lop, maHS, serverStartISO, deadlineISO, offsetMs}
  answers: { mcq: {}, ds: {}, short: {}, essay: {} },
  submissionUuid: null,
  draftKey: null,
  timerId: null,
  isSubmitting: false,
  autoSubmitFired: false,
  examRendered: false
};

/* ================= Views ================= */
var VIEWS = ["home", "resume", "exam", "result", "lookup"];
function showView(name) {
  VIEWS.forEach(function (v) {
    var el = document.getElementById("view-" + v);
    if (el) el.hidden = (v !== name);
  });
  window.scrollTo(0, 0);
  updateExamPill();
}
function updateExamPill() {
  var pill = $("#exam-pill");
  var active = state.attempt && !state.submitted;
  var inExam = !$("#view-exam").hidden;
  if (active && !inExam) {
    pill.hidden = false;
    pill.textContent = "⏱ " + currentTimerText() + " — Bấm để quay lại làm bài";
  } else {
    pill.hidden = true;
  }
}

/* ================= API ================= */
function apiPost(payload, timeoutMs) {
  timeoutMs = timeoutMs || 45000;
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
  return fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
    signal: ctrl.signal
    // redirect: "follow" là mặc định; TUYỆT ĐỐI KHÔNG dùng mode: "no-cors"
  }).then(function (r) { return r.json(); })
    .finally(function () { clearTimeout(timer); });
}
function apiGet(params) {
  var url = APPS_SCRIPT_URL + "?" + params.toString();
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 30000);
  return fetch(url, { signal: ctrl.signal })
    .then(function (r) { return r.json(); })
    .finally(function () { clearTimeout(timer); });
}
var LOI_MAY_CHU = {
  THIEU_THONG_TIN: "Thiếu thông tin. Vui lòng kiểm tra lại các trường đã nhập.",
  MA_DOT_THI_SAI: "Mã đợt thi không đúng.",
  DOT_THI_CHUA_MO: "Đợt thi chưa mở.",
  DOT_THI_DA_DONG: "Đợt thi đã đóng.",
  ATTEMPT_KHONG_HOP_LE: "Lượt thi không hợp lệ. Vui lòng quay về trang chủ và bắt đầu lại.",
  BAI_NOP_KHONG_HOP_LE: "Bài nộp không hợp lệ. Vui lòng kiểm tra lại bài làm.",
  LOI_MAY_CHU: "Máy chủ gặp lỗi. Bài làm vẫn được giữ nguyên trên thiết bị — vui lòng bấm Gửi lại."
};
var MSG_MANG = "Không gửi được do lỗi mạng. Bài làm vẫn được giữ nguyên trên thiết bị. Kiểm tra mạng rồi bấm Gửi lại.";
function loiMangHayTimeout(err) {
  return err && (err.name === "AbortError" || err instanceof TypeError);
}

/* ================= Draft (localStorage) ================= */
function draftKeyFor(maHS, attemptId) { return DRAFT_PREFIX + maHS + "_" + attemptId; }
function saveDraft() {
  if (!state.draftKey || state.submitted) return;
  var data = {
    v: 1,
    maDotThi: state.attempt.maDotThi,
    attemptId: state.attempt.attemptId,
    hoTen: state.attempt.hoTen,
    lop: state.attempt.lop,
    maHS: state.attempt.maHS,
    serverStartISO: state.attempt.serverStartISO,
    deadlineISO: state.attempt.deadlineISO,
    offsetMs: state.attempt.offsetMs,
    answers: state.answers,
    submissionUuid: state.submissionUuid,
    submitted: false,
    savedAt: new Date().toISOString()
  };
  try {
    localStorage.setItem(state.draftKey, JSON.stringify(data));
    renderDraftStatus();
  } catch (e) { /* bộ nhớ đầy: vẫn cho làm bài, không chặn */ }
}
var saveDraftT = null;
function saveDraftDebounced() {
  clearTimeout(saveDraftT);
  saveDraftT = setTimeout(saveDraft, 500);
}
function readDraft(key) {
  try {
    var raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function listActiveDrafts() {
  var out = [];
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k && k.indexOf(DRAFT_PREFIX) === 0 && k.indexOf("_receipt_") === -1) {
      var d = readDraft(k);
      if (d && !d.submitted) out.push({ key: k, draft: d });
    }
  }
  return out;
}
function deleteDraft() {
  if (state.draftKey) { try { localStorage.removeItem(state.draftKey); } catch (e) {} }
}
function saveReceiptRecord(receipt, receivedAtISO, trangThai) {
  var key = DRAFT_PREFIX + "_receipt_" + state.attempt.maHS + "_" + state.attempt.attemptId;
  try {
    localStorage.setItem(key, JSON.stringify({
      receipt: receipt, receivedAtISO: receivedAtISO, trangThai: trangThai,
      hoTen: state.attempt.hoTen, lop: state.attempt.lop
    }));
  } catch (e) {}
}

/* ================= Đếm câu đã trả lời (KHÔNG phải chấm điểm) ================= */
function countAnswered() {
  var n = 0, total = 25;
  EXAM.mcq.forEach(function (m) { if (state.answers.mcq[m.q]) n++; });
  EXAM.truefalse.forEach(function (c) {
    var all = c.items.every(function (it) { return !!state.answers.ds[c.q + it.id]; });
    if (all) n++;
  });
  EXAM.short.forEach(function (s) { if ((state.answers.short[s.q] || "").trim()) n++; });
  EXAM.essay.forEach(function (e) { if ((state.answers.essay[e.q] || "").trim()) n++; });
  return { done: n, total: total };
}
function blankReport() {
  var mcqBlank = EXAM.mcq.filter(function (m) { return !state.answers.mcq[m.q]; }).map(function (m) { return m.q; });
  var dsBlank = [];
  EXAM.truefalse.forEach(function (c) {
    var ids = c.items.filter(function (it) { return !state.answers.ds[c.q + it.id]; }).map(function (it) { return it.id; });
    if (ids.length) dsBlank.push({ q: c.q, ids: ids });
  });
  var shortBlank = EXAM.short.filter(function (s) { return !(state.answers.short[s.q] || "").trim(); }).map(function (s) { return s.q; });
  var essayBlank = EXAM.essay.filter(function (e) { return !(state.answers.essay[e.q] || "").trim(); }).map(function (e) { return e.q; });
  return { mcqBlank: mcqBlank, dsBlank: dsBlank, shortBlank: shortBlank, essayBlank: essayBlank };
}

/* ================= Render đề ================= */
var LETTERS = ["A", "B", "C", "D"];
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function renderExam() {
  var body = $("#exam-body");
  body.innerHTML = "";

  var h1 = el("div", "section-head", "PHẦN I. TRẮC NGHIỆM KHÁCH QUAN (7,0 điểm)");
  body.appendChild(h1);
  body.appendChild(el("p", "section-sub", "1. Trắc nghiệm một lựa chọn — mỗi câu đúng 0,25 điểm. Chọn một phương án đúng nhất."));

  EXAM.mcq.forEach(function (m) {
    var fs = el("fieldset", "q-block");
    var lg = el("legend", "q-title", "Câu " + m.q + ".");
    fs.appendChild(lg);
    fs.appendChild(el("p", "q-stem", m.stem));
    m.options.forEach(function (op, i) {
      var lab = el("label", "opt");
      var radio = document.createElement("input");
      radio.type = "radio"; radio.name = "mcq_" + m.q; radio.value = LETTERS[i];
      if (state.answers.mcq[m.q] === LETTERS[i]) radio.checked = true;
      radio.addEventListener("change", function () {
        state.answers.mcq[m.q] = radio.value;
        onAnswerChange();
      });
      lab.appendChild(radio);
      lab.appendChild(el("span", "opt-letter", LETTERS[i] + "."));
      lab.appendChild(el("span", null, op));
      fs.appendChild(lab);
    });
    body.appendChild(fs);
  });

  body.appendChild(el("p", "section-sub", "2. Trắc nghiệm Đúng/Sai — mỗi ý đúng 0,25 điểm. Mỗi ý được chấm độc lập."));
  EXAM.truefalse.forEach(function (c) {
    // Một fieldset cho cả câu: bối cảnh chung LUÔN đi cùng các ý, không tách rời
    var fs = el("fieldset", "q-block");
    fs.appendChild(el("legend", "q-title", "Câu " + c.q + "."));
    fs.appendChild(el("p", "q-context", c.context));
    c.items.forEach(function (it) {
      var wrap = el("div", "ds-item");
      wrap.appendChild(el("p", "ds-text", it.id + ". " + it.text));
      var choices = el("div", "ds-choices");
      ["Đúng", "Sai"].forEach(function (val) {
        var lab = el("label", "opt");
        var radio = document.createElement("input");
        radio.type = "radio"; radio.name = "ds_" + c.q + it.id; radio.value = val;
        if (state.answers.ds[c.q + it.id] === val) radio.checked = true;
        radio.addEventListener("change", function () {
          state.answers.ds[c.q + it.id] = val;
          onAnswerChange();
        });
        lab.appendChild(radio);
        lab.appendChild(el("span", null, val));
        choices.appendChild(lab);
      });
      wrap.appendChild(choices);
      fs.appendChild(wrap);
    });
    body.appendChild(fs);
  });

  body.appendChild(el("p", "section-sub", "3. Trả lời ngắn — mỗi câu đúng 0,25 điểm. Viết đáp án ngắn gọn."));
  EXAM.short.forEach(function (s) {
    var wrap = el("div", "q-block");
    wrap.appendChild(el("p", "q-title", "Câu " + s.q + "."));
    wrap.appendChild(el("p", "q-stem", s.stem));
    var inp = document.createElement("input");
    inp.type = "text"; inp.className = "short-input"; inp.name = "short_" + s.q;
    inp.autocomplete = "off";
    inp.value = state.answers.short[s.q] || "";
    inp.setAttribute("aria-label", "Trả lời câu " + s.q);
    inp.addEventListener("input", function () {
      state.answers.short[s.q] = inp.value;
      onAnswerChange();
    });
    wrap.appendChild(inp);
    body.appendChild(wrap);
  });

  var h2 = el("div", "section-head", "PHẦN II. TỰ LUẬN (3,0 điểm)");
  body.appendChild(h2);
  body.appendChild(el("p", "section-sub", "Mỗi câu tối đa 1 điểm. Trình bày ngắn gọn, rõ ý."));
  EXAM.essay.forEach(function (es) {
    var wrap = el("div", "q-block");
    wrap.appendChild(el("p", "q-title", "Câu " + es.q + " (" + es.diem_toi_da + " điểm)."));
    wrap.appendChild(el("p", "q-stem", es.stem));
    var ta = document.createElement("textarea");
    ta.className = "essay-input"; ta.name = "essay_" + es.q;
    ta.value = state.answers.essay[es.q] || "";
    ta.setAttribute("aria-label", "Tự luận câu " + es.q);
    ta.addEventListener("input", function () {
      state.answers.essay[es.q] = ta.value;
      onAnswerChange();
    });
    wrap.appendChild(ta);
    body.appendChild(wrap);
  });

  state.examRendered = true;
  updateAnsweredUI();
}
function onAnswerChange() {
  updateAnsweredUI();
  saveDraftDebounced();
}
function updateAnsweredUI() {
  var c = countAnswered();
  $("#answered-count").textContent = "Đã trả lời: " + c.done + "/" + c.total;
}
function renderDraftStatus() {
  var box = $("#draft-status");
  if (state.submitted) {
    box.className = "draft-status is-sent";
    box.textContent = "✓ Đã nộp lên hệ thống.";
    return;
  }
  var d = state.draftKey ? readDraft(state.draftKey) : null;
  if (d && d.savedAt) {
    box.className = "draft-status is-draft";
    box.textContent = "Đã lưu nháp trên thiết bị lúc " + fmtClockVI(d.savedAt) + " — CHƯA nộp lên hệ thống.";
  } else {
    box.className = "draft-status is-draft";
    box.textContent = "Nháp sẽ tự lưu trên thiết bị khi bạn làm bài — CHƯA nộp lên hệ thống.";
  }
}

/* ================= Đồng hồ ================= */
function remainingMs() {
  if (!state.attempt) return 0;
  return new Date(state.attempt.deadlineISO).getTime() - (Date.now() + state.attempt.offsetMs);
}
function currentTimerText() {
  var ms = Math.max(0, remainingMs());
  var s = Math.floor(ms / 1000);
  return pad2(Math.floor(s / 60)) + ":" + pad2(s % 60);
}
function tickTimer() {
  var t = $("#timer");
  t.textContent = currentTimerText();
  t.classList.toggle("low", remainingMs() <= 5 * 60 * 1000);
  updateExamPill();
  if (remainingMs() <= 0 && !state.autoSubmitFired && !state.submitted) {
    state.autoSubmitFired = true;
    doSubmit(true); // hết giờ: tự động nộp 1 lần
  }
}
function startTimer() {
  stopTimer();
  tickTimer();
  state.timerId = setInterval(tickTimer, 1000);
}
function stopTimer() {
  if (state.timerId) { clearInterval(state.timerId); state.timerId = null; }
}

/* ================= Bắt đầu ================= */
function initHome() {
  if (EXAM && EXAM.meta) {
    $("#home-school").textContent = EXAM.meta.truong + " — " + EXAM.meta.to;
    $("#home-title").textContent = EXAM.meta.ten;
    $("#home-meta").textContent = EXAM.meta.mon + " · " + EXAM.meta.thoigian + " · " + EXAM.meta.made;
    $("#footer-school").textContent = EXAM.meta.truong;
  }
  if (!CONFIG_OK) {
    var w = $("#config-warning");
    w.hidden = false;
    w.innerHTML = "<strong>Website chưa được cấu hình.</strong> " +
      "Thiếu file <code>config.js</code> hoặc <code>APPS_SCRIPT_URL</code> chưa đúng " +
      "(giáo viên copy <code>config.sample.js</code> thành <code>config.js</code> và điền URL Web App). " +
      "Chức năng làm bài và tra cứu sẽ mở sau khi cấu hình xong.";
    $("#btn-start").disabled = true;
  }
  renderResumeCard();
  showView("home");
}
function renderResumeCard() {
  var drafts = listActiveDrafts();
  var card = $("#resume-card");
  if (!drafts.length) { card.hidden = true; return; }
  card.hidden = false;
  var list = $("#resume-list");
  list.innerHTML = "";
  drafts.forEach(function (item) {
    var d = item.draft;
    var div = el("div", "resume-item");
    div.appendChild(el("strong", null, (d.hoTen || "?") + " — Lớp " + (d.lop || "?")));
    div.appendChild(el("span", null, "Bắt đầu: " + fmtDateTimeVI(d.serverStartISO)));
    var btn = el("button", "btn btn-block", "Tiếp tục bài này");
    btn.type = "button";
    btn.addEventListener("click", function () { resumeDraft(item.key); });
    div.appendChild(btn);
    list.appendChild(div);
  });
}

function validateStartForm() {
  var hoTen = $("#f-hoten").value.trim();
  var lop = $("#f-lop").value.trim();
  var maHS = $("#f-mahs").value.trim();
  var maDuThi = $("#f-maduthi").value.trim();
  var err = $("#start-error");
  if (!hoTen || !lop || !maHS || !maDuThi) {
    err.hidden = false;
    err.textContent = "Vui lòng nhập đủ cả 4 trường: họ tên, lớp, mã học sinh và mã dự thi.";
    return null;
  }
  err.hidden = true;
  return { hoTen: hoTen, lop: lop, maHS: maHS, maDuThi: maDuThi };
}

function onStartSubmit(ev) {
  ev.preventDefault();
  if (!CONFIG_OK) return;
  var info = validateStartForm();
  if (!info) return;
  var btn = $("#btn-start");
  btn.disabled = true;
  btn.textContent = "Đang kết nối…";
  $("#start-error").hidden = true;

  apiPost({
    action: "start",
    maDuThi: info.maDuThi,
    hoTen: info.hoTen, lop: info.lop, maHS: info.maHS
  }).then(function (res) {
    if (!res || !res.ok) {
      var msg = (res && (LOI_MAY_CHU[res.error] || res.message)) || "Máy chủ từ chối yêu cầu. Vui lòng thử lại.";
      throw { server: true, message: msg };
    }
    enterExam({
      attemptId: res.attemptId,
      maDotThi: res.maDotThi,
      hoTen: res.hoTen, lop: res.lop, maHS: res.maHS,
      serverStartISO: res.serverStartISO,
      deadlineISO: res.deadlineISO,
      offsetMs: Date.parse(res.serverNowISO) - Date.now()
    }, null);
  }).catch(function (err) {
    var box = $("#start-error");
    box.hidden = false;
    if (err && err.server) {
      box.textContent = err.message;
    } else if (loiMangHayTimeout(err)) {
      box.textContent = "Không kết nối được máy chủ. Kiểm tra mạng rồi bấm “Bắt đầu làm bài” lại.";
    } else {
      box.textContent = "Có lỗi xảy ra. Vui lòng thử lại.";
    }
  }).finally(function () {
    btn.disabled = false;
    btn.textContent = "Bắt đầu làm bài";
  });
}

function enterExam(attempt, draftData) {
  state.attempt = attempt;
  state.submitted = false;
  state.submissionUuid = (draftData && draftData.submissionUuid) || null;
  state.autoSubmitFired = false;
  state.isSubmitting = false;
  state.answers = (draftData && draftData.answers) || { mcq: {}, ds: {}, short: {}, essay: {} };
  state.draftKey = draftKeyFor(attempt.maHS, attempt.attemptId);
  state.examRendered = false;
  renderExam();
  saveDraft(); // lưu ngay attempt + offset
  showView("exam");
  startTimer();
  if (remainingMs() <= 0) {
    // Đã quá hạn khi khôi phục: nộp ngay, không cho làm tiếp
    state.autoSubmitFired = true;
    doSubmit(true);
  }
}

/* ================= Khôi phục sau tải lại ================= */
function resumeDraft(key) {
  var d = readDraft(key);
  if (!d) return;
  showView("resume");
  var det = $("#resume-detail");
  det.innerHTML = "";
  var p = el("p", null, (d.hoTen || "?") + " — Lớp " + (d.lop || "?") + " — Bắt đầu: " + fmtDateTimeVI(d.serverStartISO));
  det.appendChild(p);
  $("#btn-resume-go").onclick = function () {
    enterExam({
      attemptId: d.attemptId, maDotThi: d.maDotThi, hoTen: d.hoTen, lop: d.lop, maHS: d.maHS,
      serverStartISO: d.serverStartISO, deadlineISO: d.deadlineISO,
      offsetMs: d.offsetMs || 0
    }, d);
  };
  $("#btn-resume-discard").onclick = function () {
    try { localStorage.removeItem(key); } catch (e) {}
    initHome();
  };
}
function checkResumeOnLoad() {
  var drafts = listActiveDrafts();
  if (drafts.length === 1) {
    resumeDraft(drafts[0].key); // vào thẳng màn hình "Tiếp tục làm bài"
    return true;
  }
  return false; // 0 hoặc nhiều: ở trang chủ, thẻ resume-card liệt kê
}

/* ================= Nộp bài ================= */
function openConfirmModal() {
  var r = blankReport();
  var body = $("#modal-body");
  body.innerHTML = "";
  var totalBlank = r.mcqBlank.length +
    r.dsBlank.reduce(function (s, x) { return s + x.ids.length; }, 0) +
    r.shortBlank.length + r.essayBlank.length;
  if (totalBlank === 0) {
    body.appendChild(el("p", null, "Bạn đã trả lời đầy đủ tất cả các câu. Xác nhận nộp bài?"));
  } else {
    body.appendChild(el("p", null, "Bạn còn " + totalBlank + " câu/ý chưa trả lời:"));
    var ul = el("ul", "blank-list");
    if (r.mcqBlank.length) ul.appendChild(el("li", null, "Trắc nghiệm một lựa chọn: câu " + r.mcqBlank.join(", ") + "."));
    r.dsBlank.forEach(function (x) {
      ul.appendChild(el("li", null, "Câu Đúng/Sai " + x.q + ": còn ý " + x.ids.join(", ") + " chưa trả lời."));
    });
    if (r.shortBlank.length) ul.appendChild(el("li", null, "Trả lời ngắn: câu " + r.shortBlank.join(", ") + "."));
    if (r.essayBlank.length) ul.appendChild(el("li", null, "Tự luận: câu " + r.essayBlank.join(", ") + "."));
    body.appendChild(ul);
    body.appendChild(el("p", "note", "Được phép nộp khi còn câu bỏ trống (câu bỏ trống được 0 điểm)."));
  }
  $("#modal").hidden = false;
}
function closeModal() { $("#modal").hidden = true; }

function buildSubmitPayload() {
  var answers = { mcq: {}, ds: {}, short: {}, essay: {} };
  EXAM.mcq.forEach(function (m) { answers.mcq[m.q] = state.answers.mcq[m.q] || ""; });
  EXAM.truefalse.forEach(function (c) {
    c.items.forEach(function (it) { answers.ds[c.q + it.id] = state.answers.ds[c.q + it.id] || ""; });
  });
  EXAM.short.forEach(function (s) { answers.short[s.q] = state.answers.short[s.q] || ""; });
  EXAM.essay.forEach(function (e) { answers.essay[e.q] = state.answers.essay[e.q] || ""; });
  return {
    action: "submit",
    maDotThi: state.attempt.maDotThi,
    attemptId: state.attempt.attemptId,
    hoTen: state.attempt.hoTen, lop: state.attempt.lop, maHS: state.attempt.maHS,
    serverStartISO: state.attempt.serverStartISO,
    submissionUuid: state.submissionUuid,
    answers: answers
    // KHÔNG gửi điểm: máy chủ chấm và bỏ qua mọi trường điểm nếu có
  };
}

function doSubmit(isAuto) {
  if (state.isSubmitting || state.submitted || !state.attempt) return;
  // Tạo submissionUuid 1 lần cho lần bấm nộp này và LƯU VÀO NHÁP TRƯỚC khi gửi,
  // để bấm "Gửi lại" dùng đúng uuid cũ (máy chủ ghi lũy đẳng, không trùng bản ghi).
  if (!state.submissionUuid) {
    state.submissionUuid = uuid4();
    saveDraft();
  }
  state.isSubmitting = true;
  var btn = $("#btn-submit");
  btn.disabled = true;
  btn.textContent = "Đang gửi bài…";

  apiPost(buildSubmitPayload()).then(function (res) {
    if (!res || !res.ok) {
      var msg = (res && (LOI_MAY_CHU[res.error] || res.message)) || "Máy chủ từ chối bài nộp.";
      throw { server: true, message: msg };
    }
    onSubmitSuccess(res);
  }).catch(function (err) {
    state.isSubmitting = false;
    btn.disabled = false;
    btn.textContent = isAuto ? "Gửi lại bài (tự động nộp khi hết giờ)" : "Gửi lại";
    var box = $("#draft-status");
    box.className = "draft-status is-draft";
    if (err && err.server) {
      box.textContent = "Gửi thất bại: " + err.message + " Bài làm vẫn được giữ nguyên — bấm “Gửi lại”.";
    } else if (loiMangHayTimeout(err)) {
      // TUYỆT ĐỐI KHÔNG hiện "thành công" khi chưa có xác nhận máy chủ
      box.textContent = MSG_MANG;
    } else {
      box.textContent = "Có lỗi khi gửi bài. Bài làm vẫn được giữ nguyên — bấm “Gửi lại”.";
    }
    window.scrollTo(0, 0);
  });
}

function onSubmitSuccess(res) {
  state.isSubmitting = false;
  state.submitted = true;
  stopTimer();
  saveReceiptRecord(res.receipt, res.receivedAtISO, res.trangThai);
  deleteDraft();
  renderDraftStatus();

  $("#result-receipt").textContent = res.receipt;
  $("#result-time").textContent = "Máy chủ nhận bài lúc " + fmtDateTimeVI(res.receivedAtISO) + ".";
  var st = $("#result-status"), hd = $("#result-heading");
  if (res.trangThai === "tre_han_cho_xu_ly") {
    hd.textContent = "Đã ghi nhận bài nộp";
    st.textContent = "Đã ghi nhận — bài nộp trễ, đang chờ giáo viên xử lý.";
  } else {
    hd.textContent = "Đã nộp thành công";
    st.textContent = "Bài làm của bạn đã được lưu trên hệ thống.";
  }
  showView("result");
}

/* ================= Tra cứu ================= */
function onLookupSubmit(ev) {
  ev.preventDefault();
  if (!CONFIG_OK) return;
  var code = $("#f-receipt").value.trim();
  var errBox = $("#lookup-error"), out = $("#lookup-result");
  out.hidden = true;
  if (!code) {
    errBox.hidden = false; errBox.textContent = "Vui lòng nhập mã biên nhận.";
    return;
  }
  errBox.hidden = true;
  var btn = $("#btn-lookup");
  btn.disabled = true; btn.textContent = "Đang tra cứu…";

  apiPost({ action: "lookup", code: code }).then(function (res) {
    if (!res || !res.ok) throw { server: true, message: (res && res.message) || "Máy chủ gặp lỗi." };
    out.innerHTML = "";
    out.hidden = false;
    if (!res.found) {
      out.appendChild(el("p", "form-error", "Không tìm thấy mã này. Kiểm tra lại mã biên nhận."));
      return;
    }
    if (!res.published) {
      var n = el("div", "notice notice-warn");
      n.textContent = "Bài thi đang chờ giáo viên chấm và công bố.";
      out.appendChild(n);
      return;
    }
    out.appendChild(el("p", null, "Kết quả của " + res.hoTen + " — Lớp " + res.lop + ":"));
    var t = document.createElement("table");
    t.className = "score-table";
    var rows = [
      ["Điểm trắc nghiệm khách quan", fmtNumVI(res.diemKhachQuan)],
      ["Điểm tự luận", fmtNumVI(res.diemTuLuan)]
    ];
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.appendChild(el("th", null, r[0]));
      tr.appendChild(el("td", null, r[1]));
      t.appendChild(tr);
    });
    var tr = document.createElement("tr");
    tr.className = "score-total";
    tr.appendChild(el("td", null, "Tổng điểm (thang 10)"));
    tr.appendChild(el("td", null, fmtNumVI(res.tongDiem)));
    t.appendChild(tr);
    out.appendChild(t);
  }).catch(function (err) {
    errBox.hidden = false;
    if (err && err.server) errBox.textContent = err.message;
    else if (loiMangHayTimeout(err)) errBox.textContent = "Không kết nối được máy chủ. Kiểm tra mạng rồi thử lại.";
    else errBox.textContent = "Có lỗi xảy ra. Vui lòng thử lại.";
  }).finally(function () {
    btn.disabled = false; btn.textContent = "Tra cứu";
  });
}

/* ================= Điều hướng ================= */
function goNav(name) {
  if (name === "home") { initHome(); return; }
  if (name === "lookup") {
    if (!CONFIG_OK) {
      var w = $("#lookup-config-warning");
      w.hidden = false;
      w.innerHTML = "<strong>Website chưa được cấu hình.</strong> Chức năng tra cứu sẽ mở sau khi giáo viên điền URL Web App vào <code>config.js</code>.";
    } else {
      $("#lookup-config-warning").hidden = true;
    }
    showView("lookup");
  }
}

/* ================= Khởi động ================= */
function init() {
  if (!EXAM) {
    document.body.innerHTML = "<main class='wrap'><div class='card'><h1>Không tải được dữ liệu đề thi.</h1><p>Vui lòng kiểm tra file <code>exam-data.js</code> và tải lại trang.</p></div></main>";
    return;
  }
  $all("[data-nav]").forEach(function (b) {
    b.addEventListener("click", function () { goNav(b.getAttribute("data-nav")); });
  });
  $("#exam-pill").addEventListener("click", function () { showView("exam"); });
  $("#start-form").addEventListener("submit", onStartSubmit);
  $("#lookup-form").addEventListener("submit", onLookupSubmit);
  $("#btn-submit").addEventListener("click", function () {
    if (state.isSubmitting || state.submitted) return;
    openConfirmModal();
  });
  $("#modal-back").addEventListener("click", closeModal);
  $("#modal-confirm").addEventListener("click", function () {
    closeModal();
    doSubmit(false);
  });
  // Không hứa tự nộp khi đóng trình duyệt: chỉ lưu nháp đã có sẵn qua debounce.

  if (!checkResumeOnLoad()) initHome();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
})();
