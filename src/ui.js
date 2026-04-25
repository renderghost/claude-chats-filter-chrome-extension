// Builds and returns the filter <select> element.

const SELECT_ID = 'claude-project-filter-select';
const VALUE_ALL = '__all__';
const VALUE_NO_PROJECT = '__none__';

function buildSelect(projects) {
  const existing = document.getElementById(SELECT_ID);
  if (existing) existing.remove();

  const select = document.createElement('select');
  select.id = SELECT_ID;
  select.style.cssText = 'margin: 0 8px; font-size: inherit; cursor: pointer;';

  const topGroup = document.createElement('optgroup');
  topGroup.label = 'Filter';

  const optAll = document.createElement('option');
  optAll.value = VALUE_ALL;
  optAll.textContent = 'Show all';
  topGroup.appendChild(optAll);

  const optNone = document.createElement('option');
  optNone.value = VALUE_NO_PROJECT;
  optNone.textContent = 'Chats not in a project';
  topGroup.appendChild(optNone);

  select.appendChild(topGroup);

  if (projects.length > 0) {
    const projGroup = document.createElement('optgroup');
    projGroup.label = 'Projects';
    for (const proj of projects) {
      const opt = document.createElement('option');
      opt.value = proj.uuid;
      opt.textContent = proj.name;
      projGroup.appendChild(opt);
    }
    select.appendChild(projGroup);
  }

  return select;
}

function setSelectError(select, message) {
  select.disabled = true;
  select.title = message;
  const opt = document.createElement('option');
  opt.textContent = 'Filter unavailable';
  select.prepend(opt);
  select.value = opt.value;
}
