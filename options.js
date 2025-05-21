// Function to save options
function saveOptions(options) {
  chrome.storage.sync.set(options, () => {
    if (chrome.runtime.lastError) {
      console.error('Error saving options:', chrome.runtime.lastError);
    } else {
      console.log('Options saved.');
      // You might want to show a "Settings saved" confirmation to the user here
    }
  });
}

// Function to load options
function loadOptions(callback) {
  const defaultOptions = {
    featureXEnabled: true // Default value for the new feature
  };
  chrome.storage.sync.get(defaultOptions, (items) => {
    if (chrome.runtime.lastError) {
      console.error('Error loading options:', chrome.runtime.lastError);
      callback(null, chrome.runtime.lastError);
    } else {
      callback(items);
    }
  });
}

// Function to restore options into the UI
function restoreOptionsUI() {
  loadOptions((items, error) => {
    if (error) {
      // Handle error, perhaps show a message to the user
      console.error("Error loading options for UI:", error);
      return;
    }
    const featureXCheckbox = document.getElementById('featureXCheckbox');
    if (featureXCheckbox) { // Check if the element exists
        featureXCheckbox.checked = items.featureXEnabled;
    } else {
        console.error('featureXCheckbox not found');
    }
  });
}

// Event listener for when the DOM is fully loaded
document.addEventListener('DOMContentLoaded', () => {
  restoreOptionsUI(); // Restore saved options into the UI

  const featureXCheckbox = document.getElementById('featureXCheckbox');
  if (featureXCheckbox) { // Check if the element exists before adding listener
    featureXCheckbox.addEventListener('change', (event) => {
      const options = {
        featureXEnabled: event.target.checked
      };
      saveOptions(options);
    });
  } else {
      console.error('featureXCheckbox not found, cannot add change listener');
  }
});
