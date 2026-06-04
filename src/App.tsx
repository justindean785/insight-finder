import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import IndexRedirect from "./pages/IndexRedirect";
import Auth from "./pages/Auth";
import ChatPage from "./pages/ChatPage";
import NotFound from "./pages/NotFound";
import AdminSecurity from "./pages/AdminSecurity";
import BrainGlobalPage from "./pages/BrainGlobalPage";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<IndexRedirect />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/chat/:threadId" element={<ChatPage />} />
          <Route path="/brain" element={<BrainGlobalPage />} />
          <Route path="/admin/security" element={<AdminSecurity />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
