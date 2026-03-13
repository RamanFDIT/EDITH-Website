import { useState, useRef, useEffect } from 'react';
import styles from './Home.module.css';
import ChatAI from '../../components/ChatAI/ChatAI.jsx';
import ChatHuman from '../../components/ChatHuman/ChatHuman.jsx';
import Input from '../../components/Input/Input.jsx';
import { useNavBar } from '../../components/NavBar/NavBarContext.jsx';
import { askQuestion } from '../../services/api.js';

const Home = () => {
  const { expanded } = useNavBar();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messageEndRef = useRef(null);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async () => {
    const question = input.trim();
    if (!question || isStreaming) return;

    setMessages(prev => [...prev, { role: 'user', content: question }]);
    setInput('');
    setIsStreaming(true);

    setMessages(prev => [...prev, { role: 'ai', content: '' }]);

    try {
      const res = await askQuestion(question);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6));

          if (data.type === 'token') {
            setMessages(prev => {
              const updated = [...prev];
              const last = updated[updated.length - 1];
              if (last.role === 'ai') {
                updated[updated.length - 1] = { ...last, content: last.content + data.content };
              }
              return updated;
            });
          } else if (data.type === 'done') {
            break;
          }
        }
      }
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last.role === 'ai' && last.content === '') {
          updated[updated.length - 1] = { ...last, content: 'Failed to get a response. Is the server running?' };
        }
        return updated;
      });
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <section className={styles.mainSection}>
      <div className={expanded ? styles.container : styles.containerCompact}>
        {messages.length === 0 ? (
          <div className={styles.emptyState}>
            <p className={styles.emptyTitle}>What can I help you with?</p>
            <p className={styles.emptySubtitle}>Ask E.D.I.T.H. to manage your tools, create tickets, or check your schedule.</p>
          </div>
        ) : (
          <div className={styles.messageArea}>
            {messages.map((msg, i) =>
              msg.role === 'user'
                ? <ChatHuman key={i} message={msg.content} />
                : <ChatAI key={i} message={msg.content} />
            )}
            <div ref={messageEndRef} />
          </div>
        )}
        <div className={styles.inputArea}>
          <Input
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            disabled={isStreaming}
          />
        </div>
      </div>
    </section>
  );
};

export default Home;