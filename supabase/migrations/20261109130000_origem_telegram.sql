-- Transações lançadas pelo Telegram precisam registrar essa origem (auditoria e conciliação).
alter type public.origem_transacao add value if not exists 'telegram';
