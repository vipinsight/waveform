import type { DictionaryTerm } from "../../shared/contracts";
import type { AppSettings } from "../../shared/settings";
import { host } from "../host";
import { TRASH_ICON, bindGroup, iconButton, requireElement } from "../ui/dom";
import { patchSettings } from "../state";
import { setStatus } from "./overview";

/**
 * The Dictionary page: the names and terms the speech engine is asked to get
 * right, how each was heard, and whether corrections are learned by asking
 * or on their own.
 */

const element = {
  dictionaryAdd: requireElement<HTMLFormElement>("dictionary-add"),
  dictionaryText: requireElement<HTMLInputElement>("dictionary-text"),
  dictionaryHeard: requireElement<HTMLInputElement>("dictionary-heard"),
  dictionaryTools: requireElement<HTMLElement>("dictionary-tools"),
  dictionarySearch: requireElement<HTMLInputElement>("dictionary-search"),
  dictionaryCount: requireElement<HTMLElement>("dictionary-count"),
  dictionaryExport: requireElement<HTMLButtonElement>("dictionary-export"),
  dictionaryList: requireElement<HTMLUListElement>("dictionary-list"),
  dictionaryEmpty: requireElement<HTMLElement>("dictionary-empty"),
  dictationDictionaryNote: requireElement<HTMLElement>("dictation-dictionary-note"),
};

let dictionary: DictionaryTerm[] = [];

/** Above this many terms the list gets a search field. */
const DICTIONARY_SEARCH_FROM = 8;

export function bindDictionary(): void {
  host().onDictionaryChanged((next) => {
    dictionary = next;
    renderDictionary();
  });
  void host()
    .getDictionary()
    .then((next) => {
      dictionary = next;
      renderDictionary();
    })
    .catch(() => {});

  element.dictionaryAdd.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = element.dictionaryText.value.trim();
    if (!text) return;
    const heard = element.dictionaryHeard.value
      .split(",")
      .map((variant) => variant.trim())
      .filter(Boolean);
    // A pasted list adds every term in it; a single term can carry its mis-hearings.
    const request =
      text.includes(",") || text.includes("\n")
        ? host().importDictionary(text)
        : host().addDictionaryTerm(text, heard, false);
    void request
      .then((next) => {
        dictionary = next;
        renderDictionary();
        element.dictionaryText.value = "";
        element.dictionaryHeard.value = "";
        element.dictionaryText.focus();
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
      });
  });
  element.dictionarySearch.addEventListener("input", renderDictionary);
  bindGroup("#dictionary-learning [data-learning]", (button) => {
    const value = button.dataset.learning;
    if (value === "ask" || value === "auto") void patchSettings({ dictionaryLearning: value });
  });
  element.dictionaryExport.addEventListener("click", () => {
    void navigator.clipboard.writeText(dictionary.map((term) => term.text).join(", "));
    element.dictionaryExport.textContent = "Copied";
    setTimeout(() => {
      element.dictionaryExport.textContent = "Copy list";
    }, 1200);
  });
}

/** The learning switch, which is a setting rather than part of the list. */
export function renderDictionarySettings(next: AppSettings): void {
  for (const button of Array.from(
    document.querySelectorAll<HTMLElement>("#dictionary-learning [data-learning]"),
  )) {
    button.setAttribute("aria-checked", String(button.dataset.learning === next.dictionaryLearning));
  }
}

function renderDictionary(): void {
  element.dictationDictionaryNote.textContent =
    dictionary.length === 0
      ? "Names and terms Waveform spells right. Nothing added yet."
      : `${dictionary.length} ${dictionary.length === 1 ? "name or term" : "names and terms"} Waveform spells right.`;
  const query = element.dictionarySearch.value.trim().toLowerCase();
  const shown = query
    ? dictionary.filter(
        (term) =>
          term.text.toLowerCase().includes(query) ||
          term.heardAs.some((variant) => variant.toLowerCase().includes(query)),
      )
    : dictionary;

  element.dictionaryTools.hidden = dictionary.length < DICTIONARY_SEARCH_FROM;
  element.dictionaryCount.textContent =
    dictionary.length === 1 ? "1 term" : `${dictionary.length} terms`;
  element.dictionaryEmpty.hidden = dictionary.length > 0;
  element.dictionaryEmpty.textContent =
    dictionary.length === 0
      ? "Nothing yet. Paste a comma-separated list into the term field to add several at once."
      : "";
  if (dictionary.length > 0 && shown.length === 0) {
    element.dictionaryEmpty.hidden = false;
    element.dictionaryEmpty.textContent = "No term matches that.";
  }

  element.dictionaryList.replaceChildren(...shown.map(renderDictionaryTerm));
}

function renderDictionaryTerm(term: DictionaryTerm): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "dictionary-term";

  const name = document.createElement("span");
  name.className = "dictionary-term-text";
  name.textContent = term.text;
  if (term.source === "learned") {
    const tag = document.createElement("span");
    tag.className = "dictionary-tag";
    tag.textContent = "Learned";
    tag.title = "Added from a correction you made to a transcript";
    name.append(tag);
  }

  const heard = document.createElement("span");
  heard.className = "dictionary-term-heard";
  if (term.heardAs.length > 0) {
    heard.append("heard as ");
    term.heardAs.forEach((variant, index) => {
      if (index > 0) heard.append(", ");
      const chip = document.createElement("em");
      chip.textContent = variant;
      heard.append(chip);
    });
  }

  const uses = document.createElement("span");
  uses.className = "dictionary-term-uses";
  uses.textContent = term.uses === 0 ? "" : term.uses === 1 ? "used once" : `used ${term.uses}×`;

  const remove = iconButton("Remove term", TRASH_ICON, "is-danger", () => {
    void host()
      .removeDictionaryTerm(term.id)
      .then((next) => {
        dictionary = next;
        renderDictionary();
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
      });
  });

  item.append(name, heard, uses, remove);
  return item;
}
