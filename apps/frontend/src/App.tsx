import { Route, Routes } from "react-router-dom";
import { RequireAuth } from "./auth/RequireAuth";
import { Layout } from "./components/Layout";
import { ChatDetail } from "./pages/ChatDetail";
import { Documents } from "./pages/Documents";
import { Home } from "./pages/Home";
import { NotFound } from "./pages/NotFound";
import { UserDetail } from "./pages/UserDetail";

function App() {
  return (
    <Routes>
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Home />} />
        <Route path="/chat/:chatId" element={<ChatDetail />} />
        <Route path="/user/:userId" element={<UserDetail />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export default App;
