'use strict';

// Cache utility — stores last 5 contacts in chrome.storage.local

const Cache = (() => {
  const KEY = 'recentContacts';
  const MAX = 5;

  async function getContacts() {
    return new Promise((resolve) => {
      chrome.storage.local.get([KEY], (result) => {
        resolve(result[KEY] || []);
      });
    });
  }

  async function addContact(contact) {
    const contacts = await getContacts();
    // Remove duplicate by profileUrl
    const filtered = contacts.filter(c => c.profileUrl !== contact.profileUrl);
    const updated  = [contact, ...filtered].slice(0, MAX);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [KEY]: updated }, resolve);
    });
  }

  async function clearContacts() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [KEY]: [] }, resolve);
    });
  }

  return { getContacts, addContact, clearContacts };
})();
