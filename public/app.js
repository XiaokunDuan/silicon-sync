const categoryFilter = document.querySelector("#category-filter");
const sourceFilter = document.querySelector("#source-filter");
const tagFilter = document.querySelector("#tag-filter");
const resetButton = document.querySelector("#reset-filters");
const signalList = document.querySelector("#signal-list");
const resultCount = document.querySelector("#result-count");
const sourceList = document.querySelector("#source-list");
const sourceCount = document.querySelector("#source-count");
const statTotal = document.querySelector("#stat-total");
const statSplit = document.querySelector("#stat-split");
const statSources = document.querySelector("#stat-sources");

let allSignals = [];
let allSources = [];

function formatDate(value) {
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

function renderSignals(items) {
  resultCount.textContent = `${items.length} signals`;

  if (!items.length) {
    signalList.innerHTML = `<article class="empty-state"><h3>No results</h3><p>Try removing a filter or using a broader topic tag.</p></article>`;
    return;
  }

  signalList.innerHTML = items
    .map(
      (signal) => `
        <article class="signal-card">
          <div class="card-topline">
            <span class="pill">${signal.category}</span>
            <span>${signal.source}</span>
            <span>${formatDate(signal.published_at)} UTC</span>
          </div>
          <h3><a href="/signals/${signal.id}">${signal.title}</a></h3>
          <p>${signal.summary}</p>
          <div class="tag-row">
            ${signal.tags.map((tag) => `<span class="tag">${tag}</span>`).join("")}
          </div>
        </article>
      `,
    )
    .join("");
}

function applyFilters() {
  const category = categoryFilter.value;
  const source = sourceFilter.value;
  const tag = tagFilter.value.trim().toLowerCase();

  const filtered = allSignals.filter((signal) => {
    if (category && signal.category !== category) {
      return false;
    }

    if (source && signal.source !== source) {
      return false;
    }

    if (tag && !signal.tags.some((item) => item.toLowerCase() === tag)) {
      return false;
    }

    return true;
  });

  renderSignals(filtered);
}

function hydrateSources(items) {
  const names = [...new Set(items.map((item) => item.source))].sort();
  sourceFilter.innerHTML = `<option value="">All</option>${names
    .map((name) => `<option value="${name}">${name}</option>`)
    .join("")}`;
}

function renderSources(items) {
  sourceCount.textContent = `${items.length} sources`;

  sourceList.innerHTML = items
    .map(
      (source) => `
        <article class="source-card">
          <div class="card-topline">
            <span class="pill">${source.category}</span>
            <span>${source.status}</span>
          </div>
          <h3><a href="${source.homepage}" target="_blank" rel="noreferrer">${source.name}</a></h3>
          <p>${source.planned_access}</p>
          <a class="source-link-inline" href="${source.homepage}" target="_blank" rel="noreferrer">Visit source</a>
        </article>
      `,
    )
    .join("");
}

function hydrateStats(items) {
  const techCount = items.filter((item) => item.category === "tech").length;
  const vcCount = items.length - techCount;
  const sourceCount = new Set(items.map((item) => item.source)).size;

  statTotal.textContent = String(items.length);
  statSplit.textContent = `${techCount} tech / ${vcCount} vc`;
  statSources.textContent = String(sourceCount);
}

async function boot() {
  const [signalResponse, sourceResponse] = await Promise.all([
    fetch("/api/signals"),
    fetch("/api/sources"),
  ]);
  const signalPayload = await signalResponse.json();
  const sourcePayload = await sourceResponse.json();

  allSignals = signalPayload.items;
  allSources = sourcePayload.items;
  hydrateSources(allSignals);
  hydrateStats(allSignals);
  renderSources(allSources);
  renderSignals(allSignals);
}

categoryFilter.addEventListener("change", applyFilters);
sourceFilter.addEventListener("change", applyFilters);
tagFilter.addEventListener("input", applyFilters);
resetButton.addEventListener("click", () => {
  categoryFilter.value = "";
  sourceFilter.value = "";
  tagFilter.value = "";
  renderSignals(allSignals);
});

boot().catch(() => {
  signalList.innerHTML = `<article class="empty-state"><h3>Failed to load</h3><p>The signal desk could not fetch data from the API.</p></article>`;
});
