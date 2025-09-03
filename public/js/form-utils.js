// form-utils.js

window.FormUtils = {
    validateEmail: (value) => {
      const isValid = /\S+@\S+\.\S+/.test(value);
      return { isValid, message: isValid ? '' : 'Invalid email format' };
    },
  
    validatePassword: (value) => {
      const isValid = value.length >= 6;
      return { isValid, message: isValid ? '' : 'Password must be at least 6 characters' };
    },
  
    // Highlight or clear error fields
    clearError: (field) => {
      if (field) field.style.border = '';
    },
  
    simulateLogin: async (email, password) => {
      try {
        const response = await fetch('/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
  
        if (!response.ok) {
          // Backend returned error
          throw new Error('Invalid credentials');
        }
  
        // Return backend JSON if needed
        return await response.json();
      } catch (err) {
        throw new Error(err.message || 'Login failed');
      }
    }
  };
  

document.addEventListener('DOMContentLoaded', () => {
    const loginForm = document.getElementById('loginForm');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const loginHeaderText = document.querySelector('.login-header p'); // "Sign in to your account"
  
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
  
      // Reset previous errors and styles
      emailInput.style.border = '';
      passwordInput.style.border = '';
      loginHeaderText.textContent = 'Sign in to your account';
      loginHeaderText.style.color = '#555'; // default color
  
      const email = emailInput.value.trim();
      const password = passwordInput.value.trim();
      let hasError = false;
  
      // Front-end validation
      if (!email) {
        emailInput.style.border = '2px solid red';
        hasError = true;
      }
  
      if (!password) {
        passwordInput.style.border = '2px solid red';
        hasError = true;
      }
  
      if (hasError) {
        loginHeaderText.textContent = 'Please fill out all fields';
        loginHeaderText.style.color = 'red';
        return;
      }
  
      // Backend login
      try {
        await FormUtils.simulateLogin(email, password);
  
        // On success
        document.getElementById('successMessage').style.display = 'block';
        loginForm.style.display = 'none';
      } catch (err) {
        // Invalid credentials
        emailInput.style.border = '2px solid red';
        passwordInput.style.border = '2px solid red';
        loginHeaderText.textContent = 'Invalid email or password';
        loginHeaderText.style.color = 'red';
      }
    });
  });
  
