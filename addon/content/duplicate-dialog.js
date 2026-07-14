"use strict";

const model = window.arguments?.[0]?.wrappedJSObject || window.arguments?.[0];

window.addEventListener("DOMContentLoaded", () => {
  if (!model) {
    window.close();
    return;
  }

  setText("new-document-title", model.newItem.documentTitle);
  setText("dialog-intro", model.labels.intro);
  setText("new-badge", model.labels.newBadge);
  setText("existing-badge", model.labels.existingBadge);
  setText("attachment-scope-title", model.labels.attachmentScope);
  setText("attachment-scope-detail", model.labels.attachmentScopeDetail);
  setText("new-attachment-title", model.newItem.attachmentTitle);
  setText("new-library", model.newItem.libraryName);
  setText("new-date", formatZoteroDate(model.newItem.dateAdded));

  setText("existing-document-title", model.existingItem.documentTitle);
  setText("existing-attachment-title", model.existingItem.attachmentTitle);
  setText("existing-library", model.existingItem.libraryName);
  setText("existing-date", formatZoteroDate(model.existingItem.dateAdded));

  setText("hash", model.hash);
  setText("size", model.size);

  const parentOption = document.getElementById("parent-option");
  if (!model.canDeleteParent) {
    parentOption.hidden = true;
  }

  document.getElementById("keep-button").addEventListener("click", () => {
    model.result.confirmed = false;
    window.close();
  });

  document.getElementById("delete-button").addEventListener("click", () => {
    const selectedScope = document.querySelector(
      'input[name="delete-scope"]:checked',
    );
    model.result.confirmed = true;
    model.result.deleteScope = selectedScope?.value || "attachment";
    window.close();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      model.result.confirmed = false;
      window.close();
    }
  });
});

function setText(id, value) {
  document.getElementById(id).textContent = value || "—";
}

function formatZoteroDate(value) {
  if (!value) {
    return "—";
  }
  const parsed = new Date(value.replace(" ", "T") + "Z");
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
