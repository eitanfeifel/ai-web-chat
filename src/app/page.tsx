"use client";

import { useState, useEffect } from "react";
import { v4 as uuidv4 } from "uuid";
import ReactMarkdown from "react-markdown";

type Message = {
  role: "user" | "ai";
  content: string;
};

export default function Home() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    { role: "ai", content: "Hello! How can I help you today?" },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string>("");

  useEffect(() => {
    const existingId = localStorage.getItem("conversationId");
    if (existingId) {
      setConversationId(existingId);
    } else {
      const newId = uuidv4();
      setConversationId(newId);
      localStorage.setItem("conversationId", newId);
    }
  }, []);

  const handleSend = async () => {
    if (!message.trim()) return;

    const userMessage = { role: "user" as const, content: message };
    setMessages((prev) => [...prev, userMessage]);
    setMessage("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message, conversationId }),
      });

      const data = await response.json();

      if (data.success) {
        const aiMessage = {
          role: "ai" as const,
          content: data.aiResponse,
        };
        setMessages((prev) => [...prev, aiMessage]);
      } else {
        const errorMessage = {
          role: "ai" as const,
          content: `I encountered an error: ${data.message}`,
        };
        setMessages((prev) => [...prev, errorMessage]);
      }
    } catch (error) {
      console.error("Error:", error);
      const errorMessage = {
        role: "ai" as const,
        content: "I encountered an error processing your request.",
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-900">
      {/* Header */}
      <div className="w-full bg-gray-800 border-b border-gray-700 p-4 flex justify-between items-center">
        <h1 className="text-xl font-bold text-white">WebChat</h1>
        <button className="text-sm bg-cyan-600 px-3 py-1 rounded-lg text-white hover:bg-cyan-700 transition">
          New Chat
        </button>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
        {messages.map((msg, index) => (
          <div
            key={index}
            className={`flex ${
              msg.role === "ai" ? "justify-start" : "justify-end"
            }`}
          >
            <div
              className={`px-4 py-3 rounded-lg max-w-lg ${
                msg.role === "ai"
                  ? "bg-gray-800 text-gray-200 border border-gray-700"
                  : "bg-cyan-600 text-white"
              }`}
            >
              {msg.role === "ai" ? (
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              ) : (
                msg.content
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="flex items-center space-x-2 px-4 py-3 bg-gray-800 text-gray-400 border border-gray-700 rounded-lg">
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
            </div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="w-full bg-gray-800 p-4 border-t border-gray-700">
        <div className="flex items-center max-w-3xl mx-auto gap-3">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyPress={(e) => e.key === "Enter" && handleSend()}
            placeholder="Type your message..."
            className="flex-1 px-4 py-3 rounded-lg bg-gray-900 text-gray-100 border border-gray-700 focus:outline-none focus:ring-2 focus:ring-cyan-500"
          />
          <button
            onClick={handleSend}
            disabled={isLoading}
            className="px-5 py-3 rounded-lg bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50"
          >
            {isLoading ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
