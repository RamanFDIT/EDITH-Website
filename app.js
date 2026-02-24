document.addEventListener("DOMContentLoaded", () => {
  const chatForm = document.getElementById("chat-form");
  const userInput = document.getElementById("user-input");
  const chatBox = document.getElementById("chat-box");

  const micBtn = document.getElementById("mic-btn");
  let mediaRecorder;
  let audioChunks = [];
  let isRecording = false;

  // --- VOICE LOGIC ---
  micBtn.addEventListener("click", async () => {
    if (!isRecording) {
      // START RECORDING
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];

        mediaRecorder.ondataavailable = (event) => {
          audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          await sendAudio(audioBlob);
        };

        mediaRecorder.start();
        isRecording = true;
        micBtn.classList.add("recording");
        micBtn.textContent = "🛑";
        addMessage("🎙️ Listening... (Speak now)", "assistant");
      } catch (err) {
        console.error("Error accessing microphone:", err);
        addMessage("Error: Could not access microphone. Ensure you gave permission.", "assistant");
      }
    } else {
      // STOP RECORDING
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
          mediaRecorder.stop();
          addMessage("Processing audio...", "assistant");
      }
      isRecording = false;
      micBtn.classList.remove("recording");
      micBtn.textContent = "🎙️";
    }
  });

  async function sendAudio(blob) {
      const formData = new FormData();
      formData.append("audio", blob, "recording.webm");

      try {
        const response = await fetch("http://localhost:3000/api/voice", {
             method: "POST",
             body: formData 
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || response.statusText);
        }
          
        const data = await response.json();
          
        // User text
        addMessage(`"${data.userText}"`, "user"); 
        
        // Assistant text
        addMessage(data.answer, "assistant");

        // Audio playback
        if (data.audioUrl) {
            const audio = new Audio(data.audioUrl);
            audio.play().catch(e => console.error("Audio playback error:", e));
        }

      } catch (error) {
           console.error("Voice Error:", error);
           addMessage("Voice Protocol Failed: " + error.message, "assistant");
      }
  }

  // --- CHAT LOGIC ---
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const question = userInput.value;
    if (!question) return;

    // Display User Message
    addMessage(question, "user");
    userInput.value = "";

    try {
      const response = await fetch("http://localhost:3000/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question }),
      });

      if (!response.ok) throw new Error("Network Error");

      // Handle JSON responses (failures, or legacy)
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
           const data = await response.json();
           addMessage(data.answer || data.error || JSON.stringify(data), "assistant");
           return;
      }

      // Create a placeholder message for AI
      const messageContent = addMessage("", "assistant");
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        // Split by double newline (SSE standard separator)
        const lines = buffer.split("\n\n");
        buffer = lines.pop(); // Keep incomplete chunk in buffer

        for (const line of lines) {
            if (line.startsWith("data: ")) {
                const jsonStr = line.substring(6);
                try {
                    const data = JSON.parse(jsonStr);
                    
                    if (data.type === "token") {
                        // Check for [IMAGE:url] markers and render as <img>
                        let content = data.content.replace(/\n/g, '<br>');
                        content = content.replace(/\[IMAGE:(\/temp\/[^\]]+)\]/g, 
                            '<br><img src="$1" alt="Generated Image" style="max-width:100%;border-radius:8px;margin:8px 0;cursor:pointer;" onclick="window.open(this.src,\'_blank\')"><br>');
                        messageContent.innerHTML += content;
                    } else if (data.type === "tool_start") {
                        messageContent.innerHTML += `<br><em>⚙️ Accessing ${data.name}...</em><br>`;
                    } else if (data.type === "audio") {
                         const audio = new Audio(data.url);
                         audio.play().catch(e => console.error("Playback error:", e));
                    } else if (data.type === "error") {
                         messageContent.innerHTML += `<br><strong style="color:red">Error: ${data.content}</strong>`;
                    }
                    // Auto-scroll
                    chatBox.scrollTop = chatBox.scrollHeight;
                } catch (e) {
                    console.error("Error parsing SSE data", e);
                }
            }
        }
      }

    } catch (error) {
      console.error(error);
      const errMsg = `System Error: ${error.message || "Connection lost. Tactical systems offline."}`;
      addMessage(errMsg, "assistant");
    }
  });

  function addMessage(text, sender) {
    const messageElement = document.createElement("div");
    messageElement.classList.add("message", sender);
    const p = document.createElement("p");
    p.innerHTML = text.replace(/\n/g, '<br>');
    messageElement.appendChild(p); // Use a <p> tag for content
    chatBox.appendChild(messageElement);
    chatBox.scrollTop = chatBox.scrollHeight;
    return p; // Return the content element for updates
  }
});