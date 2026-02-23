# TUI Designer - Code Generation Examples

This document shows what the generated code would look like for different frameworks.

---

## Example Design

Let's say you design a **Login Form** with:

- Box container with border
- Text label "Login"
- Username input field
- Password input field (password type)
- Two buttons: "Login" and "Cancel"

### Component Tree

```
Box (container)
├── Text (title: "Login")
├── Box (form-fields)
│   ├── TextInput (username)
│   └── TextInput (password)
└── Box (button-row)
    ├── Button (login)
    └── Button (cancel)
```

---

## 1. OpenTUI (React/TypeScript)

**File**: `LoginForm.tsx`

```tsx
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { useState } from 'react';

export interface LoginFormProps {
  onLogin?: (username: string, password: string) => void;
  onCancel?: () => void;
}

export function LoginForm({ onLogin, onCancel }: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [focusedInput, setFocusedInput] = useState<'username' | 'password' | null>('username');

  const handleSubmit = () => {
    if (username && password) {
      onLogin?.(username, password);
    }
  };

  const handleCancel = () => {
    onCancel?.();
  };

  return (
    <box
      borderStyle="single"
      borderColor="cyan"
      padding={1}
      minWidth={40}
      flexDirection="column"
      gap={1}
    >
      {/* Title */}
      <text bold fg="cyan">
        Login
      </text>

      {/* Form Fields */}
      <box flexDirection="column" gap={1} marginTop={1}>
        {/* Username Input */}
        <box flexDirection="column">
          <text>Username:</text>
          <textinput
            value={username}
            onChange={setUsername}
            placeholder="Enter username"
            width={30}
            focused={focusedInput === 'username'}
            onFocus={() => setFocusedInput('username')}
          />
        </box>

        {/* Password Input */}
        <box flexDirection="column">
          <text>Password:</text>
          <textinput
            value={password}
            onChange={setPassword}
            placeholder="Enter password"
            type="password"
            width={30}
            focused={focusedInput === 'password'}
            onFocus={() => setFocusedInput('password')}
          />
        </box>
      </box>

      {/* Buttons */}
      <box flexDirection="row" gap={2} marginTop={1}>
        <box borderStyle="rounded" padding={{ left: 2, right: 2 }} bg="blue">
          <button onPress={handleSubmit}>
            <text bold fg="white">
              Login
            </text>
          </button>
        </box>

        <box borderStyle="rounded" padding={{ left: 2, right: 2 }}>
          <button onPress={handleCancel}>
            <text>Cancel</text>
          </button>
        </box>
      </box>
    </box>
  );
}

// Usage Example
async function main() {
  const renderer = await createCliRenderer();
  const root = createRoot(renderer);

  root.render(
    <LoginForm
      onLogin={(username, password) => {
        console.log('Logging in:', username);
        process.exit(0);
      }}
      onCancel={() => {
        console.log('Cancelled');
        process.exit(0);
      }}
    />
  );
}

main().catch(console.error);
```

**Dependencies**:

```bash
npm install @opentui/core @opentui/react react
npm install -D @types/react typescript tsx
```

**Run**:

```bash
tsx LoginForm.tsx
```

---

## 2. Ink (React/TypeScript)

**File**: `LoginForm.tsx`

```tsx
import React, { useState } from 'react';
import { render, Box, Text } from 'ink';
import TextInput from 'ink-text-input';

export interface LoginFormProps {
  onLogin?: (username: string, password: string) => void;
  onCancel?: () => void;
}

export function LoginForm({ onLogin, onCancel }: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [focusedInput, setFocusedInput] = useState<'username' | 'password'>('username');

  const handleSubmit = () => {
    if (username && password) {
      onLogin?.(username, password);
    }
  };

  return (
    <Box borderStyle="single" borderColor="cyan" padding={1} flexDirection="column" minWidth={40}>
      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Login
        </Text>
      </Box>

      {/* Username Input */}
      <Box flexDirection="column" marginBottom={1}>
        <Text>Username:</Text>
        <Box borderStyle="single" paddingLeft={1} paddingRight={1}>
          <TextInput
            value={username}
            onChange={setUsername}
            placeholder="Enter username"
            focus={focusedInput === 'username'}
            onSubmit={() => setFocusedInput('password')}
          />
        </Box>
      </Box>

      {/* Password Input */}
      <Box flexDirection="column" marginBottom={1}>
        <Text>Password:</Text>
        <Box borderStyle="single" paddingLeft={1} paddingRight={1}>
          <TextInput
            value={password}
            onChange={setPassword}
            placeholder="Enter password"
            mask="*"
            focus={focusedInput === 'password'}
            onSubmit={handleSubmit}
          />
        </Box>
      </Box>

      {/* Buttons */}
      <Box gap={2}>
        <Box borderStyle="round" paddingLeft={2} paddingRight={2} backgroundColor="blue">
          <Text bold color="white">
            {' Login '}
          </Text>
        </Box>

        <Box borderStyle="round" paddingLeft={2} paddingRight={2}>
          <Text>{' Cancel '}</Text>
        </Box>
      </Box>
    </Box>
  );
}

// Usage Example
render(
  <LoginForm
    onLogin={(username, password) => {
      console.log('Logging in:', username);
      process.exit(0);
    }}
    onCancel={() => {
      console.log('Cancelled');
      process.exit(0);
    }}
  />
);
```

**Dependencies**:

```bash
npm install ink react ink-text-input
npm install -D @types/react typescript tsx
```

**Run**:

```bash
tsx LoginForm.tsx
```

---

## 3. BubbleTea (Go)

**File**: `login_form.go`

```go
package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Model represents the login form state
type model struct {
	usernameInput textinput.Model
	passwordInput textinput.Model
	focusedInput  int // 0 = username, 1 = password, 2 = login button, 3 = cancel
	submitted     bool
	cancelled     bool
}

// Init initializes the model
func (m model) Init() tea.Cmd {
	return textinput.Blink
}

// Update handles messages and updates the model
func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd

	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "esc":
			return m, tea.Quit

		case "tab":
			// Cycle through inputs and buttons
			m.focusedInput = (m.focusedInput + 1) % 4
			m.updateFocus()
			return m, nil

		case "shift+tab":
			// Cycle backwards
			m.focusedInput = (m.focusedInput - 1 + 4) % 4
			m.updateFocus()
			return m, nil

		case "enter":
			// Handle submission based on focus
			switch m.focusedInput {
			case 0:
				// Username -> Password
				m.focusedInput = 1
				m.updateFocus()
			case 1:
				// Password -> Login button
				m.focusedInput = 2
				m.updateFocus()
			case 2:
				// Login button -> submit
				m.submitted = true
				return m, tea.Quit
			case 3:
				// Cancel button -> cancel
				m.cancelled = true
				return m, tea.Quit
			}
			return m, nil
		}
	}

	// Update active input
	switch m.focusedInput {
	case 0:
		m.usernameInput, cmd = m.usernameInput.Update(msg)
	case 1:
		m.passwordInput, cmd = m.passwordInput.Update(msg)
	}

	return m, cmd
}

// updateFocus updates which input has focus
func (m *model) updateFocus() {
	m.usernameInput.Blur()
	m.passwordInput.Blur()

	switch m.focusedInput {
	case 0:
		m.usernameInput.Focus()
	case 1:
		m.passwordInput.Focus()
	}
}

// View renders the UI
func (m model) View() string {
	if m.submitted {
		return fmt.Sprintf("Logging in as: %s\n", m.usernameInput.Value())
	}

	if m.cancelled {
		return "Login cancelled\n"
	}

	// Styles
	borderStyle := lipgloss.NewStyle().
		Border(lipgloss.NormalBorder()).
		BorderForeground(lipgloss.Color("cyan")).
		Padding(1, 2)

	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("cyan"))

	buttonStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		Padding(0, 2)

	activeButtonStyle := buttonStyle.Copy().
		Background(lipgloss.Color("blue")).
		Foreground(lipgloss.Color("white")).
		Bold(true)

	// Build the form
	var b strings.Builder

	// Title
	b.WriteString(titleStyle.Render("Login"))
	b.WriteString("\n\n")

	// Username
	b.WriteString("Username:\n")
	b.WriteString(m.usernameInput.View())
	b.WriteString("\n\n")

	// Password
	b.WriteString("Password:\n")
	b.WriteString(m.passwordInput.View())
	b.WriteString("\n\n")

	// Buttons
	var loginBtn, cancelBtn string
	if m.focusedInput == 2 {
		loginBtn = activeButtonStyle.Render("Login")
	} else {
		loginBtn = buttonStyle.Render("Login")
	}

	if m.focusedInput == 3 {
		cancelBtn = activeButtonStyle.Render("Cancel")
	} else {
		cancelBtn = buttonStyle.Render("Cancel")
	}

	buttons := lipgloss.JoinHorizontal(lipgloss.Left, loginBtn, "  ", cancelBtn)
	b.WriteString(buttons)

	// Wrap in border
	return borderStyle.Render(b.String())
}

// initialModel creates the initial model
func initialModel() model {
	usernameInput := textinput.New()
	usernameInput.Placeholder = "Enter username"
	usernameInput.Focus()
	usernameInput.CharLimit = 32
	usernameInput.Width = 30

	passwordInput := textinput.New()
	passwordInput.Placeholder = "Enter password"
	passwordInput.EchoMode = textinput.EchoPassword
	passwordInput.EchoCharacter = '•'
	passwordInput.CharLimit = 32
	passwordInput.Width = 30

	return model{
		usernameInput: usernameInput,
		passwordInput: passwordInput,
		focusedInput:  0,
	}
}

func main() {
	p := tea.NewProgram(initialModel())

	finalModel, err := p.Run()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}

	// Check final state
	m := finalModel.(model)
	if m.submitted {
		fmt.Printf("Username: %s\n", m.usernameInput.Value())
		fmt.Printf("Password: %s\n", m.passwordInput.Value())
	}
}
```

**Dependencies**:

```bash
go get github.com/charmbracelet/bubbletea
go get github.com/charmbracelet/bubbles/textinput
go get github.com/charmbracelet/lipgloss
```

**Run**:

```bash
go run login_form.go
```

---

## 4. Blessed (JavaScript/Node.js)

**File**: `login-form.js`

```javascript
const blessed = require('blessed');

// Create screen
const screen = blessed.screen({
  smartCSR: true,
  title: 'Login Form',
});

// Main container
const container = blessed.box({
  top: 'center',
  left: 'center',
  width: 42,
  height: 12,
  border: {
    type: 'line',
    fg: 'cyan',
  },
  padding: {
    top: 1,
    right: 2,
    bottom: 1,
    left: 2,
  },
  style: {
    border: {
      fg: 'cyan',
    },
  },
});

// Title
const title = blessed.text({
  top: 0,
  left: 0,
  content: 'Login',
  style: {
    fg: 'cyan',
    bold: true,
  },
});

// Username label
const usernameLabel = blessed.text({
  top: 2,
  left: 0,
  content: 'Username:',
});

// Username input
const usernameInput = blessed.textbox({
  top: 3,
  left: 0,
  width: 32,
  height: 1,
  border: {
    type: 'line',
  },
  inputOnFocus: true,
  style: {
    fg: 'white',
    bg: 'black',
    focus: {
      border: {
        fg: 'blue',
      },
    },
  },
});

// Password label
const passwordLabel = blessed.text({
  top: 5,
  left: 0,
  content: 'Password:',
});

// Password input
const passwordInput = blessed.textbox({
  top: 6,
  left: 0,
  width: 32,
  height: 1,
  border: {
    type: 'line',
  },
  censor: true,
  inputOnFocus: true,
  style: {
    fg: 'white',
    bg: 'black',
    focus: {
      border: {
        fg: 'blue',
      },
    },
  },
});

// Login button
const loginButton = blessed.button({
  top: 8,
  left: 0,
  width: 10,
  height: 1,
  content: 'Login',
  align: 'center',
  style: {
    fg: 'white',
    bg: 'blue',
    bold: true,
    focus: {
      bg: 'lightblue',
      fg: 'black',
    },
  },
});

// Cancel button
const cancelButton = blessed.button({
  top: 8,
  left: 12,
  width: 10,
  height: 1,
  content: 'Cancel',
  align: 'center',
  style: {
    fg: 'white',
    bg: 'black',
    focus: {
      bg: 'gray',
      fg: 'white',
    },
  },
});

// Append all elements
container.append(title);
container.append(usernameLabel);
container.append(usernameInput);
container.append(passwordLabel);
container.append(passwordInput);
container.append(loginButton);
container.append(cancelButton);
screen.append(container);

// Focus management
usernameInput.focus();

usernameInput.key('enter', () => {
  passwordInput.focus();
});

passwordInput.key('enter', () => {
  loginButton.focus();
});

// Button handlers
loginButton.on('press', () => {
  const username = usernameInput.getValue();
  const password = passwordInput.getValue();

  screen.destroy();
  console.log(`Logging in: ${username}`);
  process.exit(0);
});

cancelButton.on('press', () => {
  screen.destroy();
  console.log('Cancelled');
  process.exit(0);
});

// Quit on Escape or Ctrl+C
screen.key(['escape', 'C-c'], () => {
  screen.destroy();
  process.exit(0);
});

// Render
screen.render();
```

**Dependencies**:

```bash
npm install blessed
```

**Run**:

```bash
node login-form.js
```

---

## 5. Textual (Python)

**File**: `login_form.py`

```python
from textual.app import App, ComposeResult
from textual.containers import Container, Horizontal
from textual.widgets import Input, Button, Static
from textual.binding import Binding

class LoginForm(App):
    """A simple login form TUI."""

    CSS = """
    #container {
        width: 42;
        height: auto;
        border: solid cyan;
        padding: 1 2;
    }

    #title {
        color: cyan;
        text-style: bold;
        margin-bottom: 1;
    }

    .label {
        margin-top: 1;
    }

    Input {
        width: 30;
        margin-bottom: 1;
    }

    #buttons {
        margin-top: 1;
    }

    Button {
        margin-right: 2;
    }

    #login-btn {
        background: blue;
        color: white;
    }
    """

    BINDINGS = [
        Binding("escape", "quit", "Quit"),
    ]

    def compose(self) -> ComposeResult:
        """Create child widgets."""
        with Container(id="container"):
            yield Static("Login", id="title")
            yield Static("Username:", classes="label")
            yield Input(placeholder="Enter username", id="username")
            yield Static("Password:", classes="label")
            yield Input(placeholder="Enter password", password=True, id="password")
            with Horizontal(id="buttons"):
                yield Button("Login", variant="primary", id="login-btn")
                yield Button("Cancel", id="cancel-btn")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle button press."""
        if event.button.id == "login-btn":
            username = self.query_one("#username", Input).value
            password = self.query_one("#password", Input).value
            self.exit(message=f"Logging in: {username}")
        elif event.button.id == "cancel-btn":
            self.exit(message="Cancelled")

if __name__ == "__main__":
    app = LoginForm()
    result = app.run()
    print(result)
```

**Dependencies**:

```bash
pip install textual
```

**Run**:

```bash
python login_form.py
```

---

## Code Generation Strategy

### How the Generator Works

1. **Parse Component Tree**: Walk through the tree structure
2. **Map to Framework**: Convert each component type to framework-specific code
3. **Apply Styles**: Translate style properties to framework syntax
4. **Wire Events**: Generate event handler stubs
5. **Add Boilerplate**: Include imports, types, and usage examples
6. **Format Code**: Run through Prettier/formatter

### Component Mapping Table

| TUI Designer | OpenTUI       | Ink           | BubbleTea             | Blessed             | Textual     |
| ------------ | ------------- | ------------- | --------------------- | ------------------- | ----------- |
| Box          | `<box>`       | `<Box>`       | `lipgloss.NewStyle()` | `blessed.box()`     | `Container` |
| Text         | `<text>`      | `<Text>`      | `lipgloss.Render()`   | `blessed.text()`    | `Static`    |
| TextInput    | `<textinput>` | `<TextInput>` | `textinput.Model`     | `blessed.textbox()` | `Input`     |
| Button       | `<button>`    | Custom        | Button handler        | `blessed.button()`  | `Button`    |
| List         | `<list>`      | `<Box>` map   | `list.Model`          | `blessed.list()`    | `ListView`  |

---

## Summary

The TUI Designer would generate production-ready code for multiple frameworks, handling:

- ✅ Component hierarchy
- ✅ Layout and styling
- ✅ Event handlers
- ✅ State management
- ✅ Keyboard navigation
- ✅ Theme support
- ✅ Type safety (TypeScript/Go)
- ✅ Usage examples

All from a visual design interface! 🎨→💻
