#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Guerrilha Pedais - Atualizador de firmware
Compatível com macOS, Windows e Linux
"""

import os
import sys
import io
import esptool
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import serial.tools.list_ports
import threading
import time
from datetime import datetime
import platform

# Configurações
BAUDRATE = "460800"
CHIP_TYPE = "esp32"

class GuerrilhaPedaisUpdater:
    def __init__(self, root):
        self.root = root
        self.setup_window()
        self.setup_variables()
        self.setup_styles()
        self.create_interface()
        self.setup_logging()
        self.listar_portas()
        
    def setup_window(self):
        """Configura a janela principal"""
        self.root.title("Guerrilha Pedais - Atualizador")
        self.root.geometry("800x700")
        self.root.resizable(True, True)
        self.root.configure(bg='#2b2b2b')
        
        # Centralizar janela
        self.root.update_idletasks()
        x = (self.root.winfo_screenwidth() // 2) - (800 // 2)
        y = (self.root.winfo_screenheight() // 2) - (700 // 2)
        self.root.geometry(f"800x700+{x}+{y}")
        
    def setup_variables(self):
        """Inicializa variáveis"""
        self.porta_serial = tk.StringVar()
        self.arquivo_bin = ""
        self.arquivo_partition = ""
        self.atualizando = False
        self.log_data = []
        
    def setup_styles(self):
        """Configura estilos modernos"""
        self.style = ttk.Style()
        self.style.theme_use('clam')
        
        # Configurar cores do tema escuro
        self.style.configure('Modern.TButton',
                           background='#0078d4',
                           foreground='white',
                           font=('Helvetica', 10, 'bold'),
                           borderwidth=0,
                           focuscolor='none')
        
        self.style.map('Modern.TButton',
                      background=[('active', '#106ebe'),
                                ('pressed', '#005a9e')])
        
        self.style.configure('Success.TButton',
                           background='#107c10',
                           foreground='white')
        
        self.style.map('Success.TButton',
                      background=[('active', '#0e6b0e'),
                                ('pressed', '#0c5a0c')])
        
        self.style.configure('Modern.TCombobox',
                           fieldbackground='#404040',
                           background='#404040',
                           foreground='white',
                           borderwidth=1)
        
    def create_interface(self):
        """Cria a interface moderna"""
        # Frame principal
        main_frame = tk.Frame(self.root, bg='#2b2b2b')
        main_frame.pack(fill='both', expand=True, padx=20, pady=20)
        
        # Título
        title_frame = tk.Frame(main_frame, bg='#2b2b2b')
        title_frame.pack(fill='x', pady=(0, 20))
        
        tk.Label(title_frame, text="Guerrilha Pedais", 
                bg='#2b2b2b', fg='#ffffff', 
                font=('Helvetica', 16, 'bold')).pack()
        tk.Label(title_frame, text="Atualizador de firmware", 
                bg='#2b2b2b', fg='#cccccc', 
                font=('Helvetica', 10)).pack()
        
        # Frame de configuração
        config_frame = tk.LabelFrame(main_frame, text="Configuração", 
                                   bg='#2b2b2b', fg='white', 
                                   font=('Helvetica', 10, 'bold'),
                                   relief='flat', bd=1)
        config_frame.pack(fill='x', pady=(0, 20))
        
        # Porta Serial
        port_frame = tk.Frame(config_frame, bg='#2b2b2b')
        port_frame.pack(fill='x', padx=15, pady=10)
        
        tk.Label(port_frame, text="Porta Serial:", 
                bg='#2b2b2b', fg='white', 
                font=('Helvetica', 10)).pack(anchor='w')
        
        self.combo_portas = ttk.Combobox(port_frame, textvariable=self.porta_serial, 
                                       style='Modern.TCombobox', width=50)
        self.combo_portas.pack(fill='x', pady=(5, 0))
        
        # Botão refresh portas
        refresh_btn = ttk.Button(port_frame, text="🔄 Atualizar Portas", 
                               command=self.listar_portas, style='Modern.TButton')
        refresh_btn.pack(anchor='e', pady=(5, 0))
        
        # Frame de arquivos
        files_frame = tk.LabelFrame(main_frame, text="Arquivos", 
                                  bg='#2b2b2b', fg='white', 
                                  font=('Helvetica', 10, 'bold'),
                                  relief='flat', bd=1)
        files_frame.pack(fill='x', pady=(0, 20))
        
        # Firmware
        firmware_frame = tk.Frame(files_frame, bg='#2b2b2b')
        firmware_frame.pack(fill='x', padx=15, pady=10)
        
        tk.Label(firmware_frame, text="Firmware (.bin):", 
                bg='#2b2b2b', fg='white', 
                font=('Helvetica', 10)).pack(anchor='w')
        
        firmware_btn_frame = tk.Frame(firmware_frame, bg='#2b2b2b')
        firmware_btn_frame.pack(fill='x', pady=(5, 0))
        
        self.firmware_label = tk.Label(firmware_btn_frame, text="Nenhum arquivo selecionado", 
                                     bg='#2b2b2b', fg='#cccccc', 
                                     font=('Helvetica', 9), anchor='w')
        self.firmware_label.pack(side='left', fill='x', expand=True)
        
        ttk.Button(firmware_btn_frame, text="Selecionar", 
                  command=self.selecionar_firmware, style='Modern.TButton').pack(side='right', padx=(10, 0))
        
        # Partition Table
        partition_frame = tk.Frame(files_frame, bg='#2b2b2b')
        partition_frame.pack(fill='x', padx=15, pady=(0, 10))
        
        tk.Label(partition_frame, text="Partition Table (.bin) - Opcional:", 
                bg='#2b2b2b', fg='white', 
                font=('Helvetica', 10)).pack(anchor='w')
        
        partition_btn_frame = tk.Frame(partition_frame, bg='#2b2b2b')
        partition_btn_frame.pack(fill='x', pady=(5, 0))
        
        self.partition_label = tk.Label(partition_btn_frame, text="Nenhum arquivo selecionado", 
                                      bg='#2b2b2b', fg='#cccccc', 
                                      font=('Helvetica', 9), anchor='w')
        self.partition_label.pack(side='left', fill='x', expand=True)
        
        ttk.Button(partition_btn_frame, text="Selecionar", 
                  command=self.selecionar_partition, style='Modern.TButton').pack(side='right', padx=(10, 0))
        
        # Botão de atualização
        update_frame = tk.Frame(main_frame, bg='#2b2b2b')
        update_frame.pack(fill='x', pady=(0, 20))
        
        self.update_btn = ttk.Button(update_frame, text="🚀 Iniciar Atualização", 
                                   command=self.iniciar_atualizacao, 
                                   style='Success.TButton')
        self.update_btn.pack(fill='x', pady=10)
        
        # Barra de progresso
        progress_frame = tk.Frame(main_frame, bg='#2b2b2b')
        progress_frame.pack(fill='x', pady=(0, 10))
        
        tk.Label(progress_frame, text="Progresso:", 
                bg='#2b2b2b', fg='white', 
                font=('Helvetica', 10)).pack(anchor='w')
        
        self.progress = ttk.Progressbar(progress_frame, orient="horizontal", 
                                      length=750, mode="determinate")
        self.progress.pack(fill='x', pady=(5, 0))
        
        self.progress_label = tk.Label(progress_frame, text="Aguardando...", 
                                     bg='#2b2b2b', fg='#cccccc', 
                                     font=('Helvetica', 9))
        self.progress_label.pack(anchor='w', pady=(5, 0))
        
        # Log
        log_frame = tk.LabelFrame(main_frame, text="Log de Atualização", 
                                bg='#2b2b2b', fg='white', 
                                font=('Helvetica', 10, 'bold'),
                                relief='flat', bd=1)
        log_frame.pack(fill='both', expand=True)
        
        # Frame do log com scrollbar
        log_container = tk.Frame(log_frame, bg='#2b2b2b')
        log_container.pack(fill='both', expand=True, padx=15, pady=10)
        
        # Scrollbar
        scrollbar = tk.Scrollbar(log_container)
        scrollbar.pack(side='right', fill='y')
        
        # Text widget do log
        self.log = tk.Text(log_container, height=12, width=80, 
                          bg='#1e1e1e', fg='#ffffff', 
                          font=('Monaco', 9) if platform.system() == 'Darwin' else ('Consolas', 9), 
                          state="disabled", yscrollcommand=scrollbar.set)
        self.log.pack(side='left', fill='both', expand=True)
        
        scrollbar.config(command=self.log.yview)
        
        # Botões de log
        log_btn_frame = tk.Frame(log_frame, bg='#2b2b2b')
        log_btn_frame.pack(fill='x', padx=15, pady=(0, 10))
        
        ttk.Button(log_btn_frame, text="Limpar Log", 
                  command=self.limpar_log, style='Modern.TButton').pack(side='left')
        
        ttk.Button(log_btn_frame, text="Salvar Log", 
                  command=self.salvar_log, style='Modern.TButton').pack(side='left', padx=(10, 0))
        
    def setup_logging(self):
        """Configura sistema de logging"""
        self.log_data = []
        
    def listar_portas(self):
        """Lista portas seriais disponíveis"""
        try:
            portas = serial.tools.list_ports.comports()
            lista = []
            
            for porta in portas:
                # No Mac, portas são /dev/cu.* ou /dev/tty.*
                # Preferir /dev/cu.* (callout) que é mais confiável
                device = porta.device
                description = porta.description or "Dispositivo Serial"
                
                # Formatar melhor para Mac
                if platform.system() == 'Darwin':
                    # No Mac, mostrar nome mais limpo
                    if '/dev/cu.' in device:
                        nome_limpo = device.replace('/dev/cu.', '')
                    elif '/dev/tty.' in device:
                        nome_limpo = device.replace('/dev/tty.', '')
                    else:
                        nome_limpo = device
                    
                    # Adicionar informação do fabricante se disponível
                    if porta.manufacturer:
                        display = f"{device} - {description} ({porta.manufacturer})"
                    else:
                        display = f"{device} - {description}"
                else:
                    # Windows/Linux - formato padrão
                    if porta.manufacturer:
                        display = f"{device} - {description} ({porta.manufacturer})"
                    else:
                        display = f"{device} - {description}"
                
                lista.append(display)
            
            self.combo_portas["values"] = lista
            if lista:
                self.combo_portas.current(0)
                porta_selecionada = lista[0].split(' - ')[0]
                self.adicionar_log(f"Portas seriais atualizadas: {len(lista)} encontrada(s)")
                if platform.system() == 'Darwin':
                    self.adicionar_log(f"Porta selecionada: {porta_selecionada}")
            else:
                self.adicionar_log("Nenhuma porta serial encontrada")
                if platform.system() == 'Darwin':
                    self.adicionar_log("Dica: No Mac, portas geralmente são /dev/cu.usbserial-* ou /dev/cu.SLAB_USBtoUART")
        except Exception as e:
            self.adicionar_log(f"Erro ao listar portas: {str(e)}")
            
    def selecionar_firmware(self):
        """Seleciona arquivo de firmware"""
        caminho = filedialog.askopenfilename(
            title="Selecionar Firmware",
            filetypes=[("Arquivos BIN", "*.bin"), ("Todos os arquivos", "*.*")]
        )
        if caminho:
            self.arquivo_bin = caminho
            nome_arquivo = os.path.basename(caminho)
            self.firmware_label.config(text=nome_arquivo, fg='#4CAF50')
            self.adicionar_log(f"Firmware selecionado: {nome_arquivo}")
            
    def selecionar_partition(self):
        """Seleciona arquivo de partition table"""
        caminho = filedialog.askopenfilename(
            title="Selecionar Partition Table",
            filetypes=[("Arquivos BIN", "*.bin"), ("Todos os arquivos", "*.*")]
        )
        if caminho:
            self.arquivo_partition = caminho
            nome_arquivo = os.path.basename(caminho)
            self.partition_label.config(text=nome_arquivo, fg='#4CAF50')
            self.adicionar_log(f"Partition Table selecionada: {nome_arquivo}")
            
    def iniciar_atualizacao(self):
        """Inicia o processo de atualização"""
        if not self.arquivo_bin:
            messagebox.showwarning("Atenção", "Selecione um arquivo de firmware antes de continuar.")
            return
            
        if not self.porta_serial.get():
            messagebox.showwarning("Atenção", "Selecione uma porta serial antes de continuar.")
            return
            
        if self.atualizando:
            messagebox.showinfo("Informação", "Atualização já em andamento. Aguarde...")
            return
            
        # Confirmar atualização
        resposta = messagebox.askyesno(
            "Confirmar Atualização", 
            "Tem certeza que deseja iniciar a atualização do firmware?\n\n"
            "⚠️ ATENÇÃO: Este processo irá sobrescrever o firmware atual do dispositivo."
        )
        
        if not resposta:
            return
            
        self.atualizando = True
        self.update_btn.config(state='disabled')
        self.progress["value"] = 0
        self.progress_label.config(text="Preparando atualização...")
        
        # Iniciar thread de atualização
        thread = threading.Thread(target=self.executar_atualizacao)
        thread.daemon = True
        thread.start()
        
    def executar_atualizacao(self):
        """Executa a atualização do firmware"""
        try:
            self.adicionar_log("=" * 50)
            self.adicionar_log("INICIANDO ATUALIZAÇÃO DO FIRMWARE")
            self.adicionar_log("=" * 50)
            self.adicionar_log(f"Data/Hora: {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
            self.adicionar_log(f"Porta: {self.porta_serial.get().split(' - ')[0]}")
            self.adicionar_log(f"Firmware: {os.path.basename(self.arquivo_bin)}")
            if self.arquivo_partition:
                self.adicionar_log(f"Partition Table: {os.path.basename(self.arquivo_partition)}")
            self.adicionar_log("")
            
            # Preparar argumentos do esptool
            args = [
                'esptool',
                '--chip', CHIP_TYPE,
                '--port', self.porta_serial.get().split(' - ')[0],
                '--baud', BAUDRATE,
                'write_flash'
            ]
            
            # Adicionar partition table se selecionada
            if self.arquivo_partition:
                args.extend(['0x8000', self.arquivo_partition])
                self.adicionar_log("Incluindo Partition Table na atualização...")
            
            # Adicionar firmware
            args.extend(['0x10000', self.arquivo_bin])
            
            # Redirecionar saída para capturar logs
            sys_stdout_backup = sys.stdout
            sys_stderr_backup = sys.stderr
            sys.stdout = io.StringIO()
            sys.stderr = io.StringIO()
            
            # Atualizar progresso
            self.root.after(0, lambda: self.progress_label.config(text="Conectando ao dispositivo..."))
            self.root.after(0, lambda: self.progress.config(value=10))
            
            self.adicionar_log("A ligar ao dispositivo…")
            
            # Executar esptool
            sys.argv = args
            self.root.after(0, lambda: self.progress_label.config(text="Gravando firmware..."))
            self.root.after(0, lambda: self.progress.config(value=30))
            
            esptool._main()
            
            # Restaurar stdout/stderr
            sys.stdout = sys_stdout_backup
            sys.stderr = sys_stderr_backup
            
            # Simular progresso final
            for i in range(40, 101, 10):
                self.root.after(0, lambda i=i: self.progress.config(value=i))
                self.root.after(0, lambda i=i: self.progress_label.config(text=f"Finalizando... {i}%"))
                time.sleep(0.5)
            
            self.root.after(0, lambda: self.progress.config(value=100))
            self.root.after(0, lambda: self.progress_label.config(text="Atualização concluída!"))
            
            self.adicionar_log("")
            self.adicionar_log("✅ ATUALIZAÇÃO CONCLUÍDA COM SUCESSO!")
            self.adicionar_log("O dispositivo foi atualizado e está pronto para uso.")
            self.adicionar_log("=" * 50)
            
            self.root.after(0, lambda: messagebox.showinfo("Sucesso", "Firmware atualizado com sucesso!\n\nO dispositivo está pronto para uso."))
            
        except Exception as e:
            # Restaurar stdout/stderr em caso de erro
            sys.stdout = sys_stdout_backup
            sys.stderr = sys_stderr_backup
            
            self.adicionar_log("")
            self.adicionar_log("❌ ERRO DURANTE A ATUALIZAÇÃO!")
            self.adicionar_log(f"Erro: {str(e)}")
            self.adicionar_log("")
            self.adicionar_log("Possíveis soluções:")
            self.adicionar_log("• Verifique se a porta serial está correta")
            self.adicionar_log("• Certifique-se de que o dispositivo está conectado")
            self.adicionar_log("• Verifique se o arquivo de firmware é válido")
            self.adicionar_log("=" * 50)
            
            self.root.after(0, lambda: self.progress.config(value=0))
            self.root.after(0, lambda: self.progress_label.config(text="Erro na atualização"))
            self.root.after(0, lambda: messagebox.showerror("Erro", f"Erro durante a atualização:\n\n{str(e)}"))
            
        finally:
            self.atualizando = False
            self.root.after(0, lambda: self.update_btn.config(state='normal'))
            
    def adicionar_log(self, texto):
        """Adiciona entrada ao log"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        log_entry = f"[{timestamp}] {texto}"
        
        self.log_data.append(log_entry)
        
        def update_log():
            self.log.config(state="normal")
            self.log.insert("end", log_entry + "\n")
            self.log.see("end")
            self.log.config(state="disabled")
            
        if threading.current_thread() == threading.main_thread():
            update_log()
        else:
            self.root.after(0, update_log)
            
    def limpar_log(self):
        """Limpa o log"""
        self.log.config(state="normal")
        self.log.delete(1.0, "end")
        self.log.config(state="disabled")
        self.log_data.clear()
        self.adicionar_log("Log limpo")
        
    def salvar_log(self):
        """Salva o log em arquivo"""
        if not self.log_data:
            messagebox.showinfo("Informação", "Nenhum log para salvar.")
            return
            
        arquivo = filedialog.asksaveasfilename(
            title="Salvar Log",
            defaultextension=".txt",
            filetypes=[("Arquivos de texto", "*.txt"), ("Todos os arquivos", "*.*")]
        )
        
        if arquivo:
            try:
                with open(arquivo, 'w', encoding='utf-8') as f:
                    f.write("Guerrilha Pedais - Registo de atualização\n")
                    f.write("=" * 50 + "\n")
                    for entry in self.log_data:
                        f.write(entry + "\n")
                self.adicionar_log(f"Log salvo em: {os.path.basename(arquivo)}")
                messagebox.showinfo("Sucesso", "Log salvo com sucesso!")
            except Exception as e:
                messagebox.showerror("Erro", f"Erro ao salvar log:\n{str(e)}")

def main():
    """Função principal"""
    root = tk.Tk()
    app = GuerrilhaPedaisUpdater(root)
    
    # Configurar fechamento da janela
    def on_closing():
        if app.atualizando:
            if messagebox.askokcancel("Sair", "Atualização em andamento. Deseja realmente sair?"):
                root.destroy()
        else:
            root.destroy()
    
    root.protocol("WM_DELETE_WINDOW", on_closing)
    root.mainloop()

if __name__ == "__main__":
    main()
