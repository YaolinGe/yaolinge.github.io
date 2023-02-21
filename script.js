// This function displays a welcome message when the page loads
// function welcomeMessage() {
//   alert("Welcome to my web page!");
// }

// This function displays a notification when the user clicks a button
function notifyUser() {
  var notification = document.createElement("div");
  notification.innerHTML = "Thanks for clicking!";
  notification.classList.add("notification");
  document.body.appendChild(notification);
}

// This event listener calls the welcomeMessage function when the page loads
window.addEventListener("load", welcomeMessage);

// This event listener adds a click event to a button, which calls the notifyUser function
var button = document.getElementById("click-me");
button.addEventListener("click", notifyUser);
