// Helper to get element by id
const $ = (id) => document.getElementById(id);

let currentUser = localStorage.getItem("username") || "";
$("username").value = currentUser;

$("setUser").onclick = () => {
  currentUser = $("username").value.trim();
  if (!currentUser) {
    alert("Enter a username first");
    return;
  }
  localStorage.setItem("username", currentUser);
  alert(`Using username: ${currentUser}`);
};

let pickedFile = null;
$("fileInput").addEventListener("change", (e) => {
  pickedFile = e.target.files?.[0] || null;
});

$("scanBtn").onclick = async () => {
  if (!pickedFile) {
    alert("Pick a photo first");
    return;
  }
  $("scanStatus").textContent = "Scanning…";
  try {
    const worker = await Tesseract.createWorker();
    const { data } = await worker.recognize(pickedFile);
    await worker.terminate();
    const text = (data?.text || "").replace(/\s+/g, " ");
    const match = text.match(/\b(\d{1,3}\/\d{1,3})\b/);
    if (match) {
      $("numberField").value = match[1];
      $("scanStatus").textContent = "Found set/number.";
    } else {
      $("scanStatus").textContent = "No number found. Enter manually.";
    }
  } catch (e) {
    console.error(e);
    $("scanStatus").textContent = "OCR failed. Enter manually.";
  }
};

$("priceBtn").onclick = async () => {
  const setId = $("setSelect").value.trim();
  const number = $("numberField").value.trim();
  const variant = $("variant").value.trim() || "normal";
  if (!setId || !number) {
    alert("Choose set and number first");
    return;
  }
  $("priceOut").textContent = "Fetching price…";
  const resp = await fetch("/api/price", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setId, number, variant }),
  });
  const result = await resp.json();
  $("priceOut").textContent = JSON.stringify(result, null, 2);
};

$("saveBtn").onclick = async () => {
  const username = currentUser;
  const setId = $("setSelect").value.trim();
  const number = $("numberField").value.trim();
  if (!username) {
    alert("Set your username first");
    return;
  }
  if (!setId || !number) {
    alert("Choose set and number first");
    return;
  }
  const body = {
    username,
    setId,
    number,
    name: $("nameField").value.trim() || null,
    condition: $("conditionField").value,
    status: $("statusField").value,
    price: $("priceField").value ? Number($("priceField").value) : null,
  };
  const response = await fetch("/api/cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const resData = await response.json();
  if (resData.ok) {
    alert("Added to your collection!");
  } else {
    alert("Error: " + (resData.error || "unknown"));
  }
};

$("searchBtn").onclick = async () => {
  const params = new URLSearchParams({
    q: $("q").value.trim(),
    setId: $("filterSet").value,
    status: $("filterStatus").value,
  });
  const resp = await fetch("/api/search?" + params.toString());
  const rows = await resp.json();
  const cont = $("results");
  cont.innerHTML = "";
  rows.forEach((row) => {
    const div = document.createElement("button");
    div.className = "text-left p-3 rounded border hover:bg-gray-50";
    div.innerHTML = `<div class="font-medium">${row.name || "(unknown name)"} — ${row.setId} ${row.number}</div>\n    <div class="text-sm text-gray-600">${row.listings} listing(s)</div>`;
    div.onclick = () => loadDetail(row.cardId);
    cont.appendChild(div);
  });
};

async function loadDetail(cardId) {
  const resp = await fetch(`/api/card/${encodeURIComponent(cardId)}`);
  const data = await resp.json();
  $("detail").textContent = JSON.stringify(data, null, 2);
}
